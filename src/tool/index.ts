import path from "node:path"
import { statSync } from "node:fs"
import { z } from "zod"
import type { AgentMode, Message } from "../message"
import { CliCodeNavigator } from "./code-navigator"
import { PermissionDeniedError, PermissionRejectedError, type PermissionRequest, type PermissionService } from "../permission"
import { isDangerousCommand, looksLikeNativeSandboxDenial, SandboxPathEscapeError, type BashResult, type Sandbox, type SandboxExecuteOptions } from "../sandbox"
import type { SkillServiceLike } from "../skill"
import { invalidProviderToolArguments } from "./utils/arguments"

export type JsonSchema = {
  type: "object"
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties: boolean
}

export type ToolResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
}

export type ToolContext = {
  agentMode: AgentMode
  sandbox: Sandbox
  permission: PermissionService
  skills: SkillServiceLike
  messages: Message[]
  signal?: AbortSignal
  onExecuteStart?: (name: string) => void
}

export type ToolDef = {
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  jsonSchema: JsonSchema
  permission: string
  modes: AgentMode[]
  patterns(input: unknown, ctx: ToolContext): string[]
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolRegistryLike {
  get(name: string): ToolDef | undefined
  list(mode?: AgentMode): ToolDef[]
  run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export class ToolRegistry implements ToolRegistryLike {
  private readonly tools = new Map<string, ToolDef>()

  register(tool: ToolDef) {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string) {
    return this.tools.get(name)
  }

  list(mode?: AgentMode) {
    return [...this.tools.values()].filter((tool) => !mode || tool.modes.includes(mode))
  }

  async run(name: string, input: unknown, ctx: ToolContext) {
    const tool = this.get(name)
    if (!tool) return { title: "Unknown tool", output: `Tool not found: ${name}`, metadata: { status: "failed" } }
    if (!tool.modes.includes(ctx.agentMode)) {
      return { title: "Tool disabled", output: `Tool ${name} is not available in ${ctx.agentMode} mode`, metadata: { status: "denied" } }
    }
    const providerArgumentError = invalidProviderToolArguments(input)
    if (providerArgumentError) {
      return { title: "Invalid tool input", output: providerArgumentError, metadata: { status: "failed", error: "invalid_tool_arguments" } }
    }
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return { title: "Invalid tool input", output: `Invalid arguments for ${name}: ${parsed.error.message}`, metadata: { status: "failed", validation: parsed.error.issues } }
    }
    try {
      const patterns = tool.patterns(parsed.data, ctx)
      const request = permissionRequestForTool(tool, parsed.data, ctx, patterns)
      const permissionAction = permissionActionFor(request.patterns.map((pattern) => ctx.permission.evaluate(tool.permission, pattern)))
      if (ctx.signal?.aborted) return toolCancelledResult(name)
      await ctx.permission.authorize(request)
      if (ctx.signal?.aborted) return toolCancelledResult(name)
      ctx.onExecuteStart?.(name)
      const result = await tool.execute(parsed.data, ctx)
      return { ...result, metadata: { ...result.metadata, permission: tool.permission, permissionAction, patterns: request.patterns } }
    } catch (error) {
      return toolErrorResult(name, error)
    }
  }
}

function permissionActionFor(actions: string[]) {
  if (actions.includes("deny")) return "deny"
  if (actions.includes("ask")) return "ask"
  return "allow"
}

function toolErrorResult(name: string, error: unknown): ToolResult {
  if (error instanceof PermissionDeniedError || error instanceof PermissionRejectedError) {
    return { title: name, output: error.message, metadata: { status: "denied", error: error.name } }
  }
  return {
    title: name,
    output: error instanceof Error ? error.message : String(error),
    metadata: { status: "failed", error: error instanceof Error ? error.name : "UnknownError" },
  }
}

function toolCancelledResult(name: string): ToolResult {
  return { title: name, output: "Tool cancelled by user.", metadata: { status: "failed", cancelled: true, error: "AbortError" } }
}

function objectSchema(properties: JsonSchema["properties"], required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

const ReadInput = z.object({ filePath: z.string() })
const OptionalString = z.string().nullish().transform((value) => value ?? undefined)
const OptionalBoolean = z.boolean().nullish().transform((value) => value ?? undefined)
const OptionalNumber = z.number().nullish().transform((value) => value ?? undefined)
const ListInput = z.object({ dirPath: OptionalString })
const GrepInput = z.object({ query: z.string(), dir: OptionalString })
const RgSearchInput = z.object({ query: z.string(), dir: OptionalString, fileType: OptionalString, maxResults: OptionalNumber })
const ReadLinesInput = z.object({ filePath: z.string(), startLine: z.number(), endLine: z.number() })
const FindDefinitionInput = z.object({ symbol: z.string(), language: OptionalString, maxResults: OptionalNumber })
const FindReferencesInput = z.object({ symbol: z.string(), language: OptionalString, maxResults: OptionalNumber })
const RepoMapInput = z.object({ dir: OptionalString, language: OptionalString, maxFiles: OptionalNumber, useCache: OptionalBoolean })
const GitDiffInput = z.object({ mode: z.enum(["summary", "files", "stat", "file"]).nullish().transform((value) => value ?? "summary"), filePath: OptionalString, maxBytes: OptionalNumber })
const WriteInput = z.object({ filePath: z.string(), content: z.string() })
const EditInput = z.object({ filePath: z.string(), oldString: z.string(), newString: z.string(), replaceAll: OptionalBoolean })
const BashInput = z.object({ command: z.string(), cwd: OptionalString, timeoutMs: OptionalNumber })
const SkillInput = z.object({ name: z.string() })
const PlanExitInput = z.object({ markdown: z.string() })

function relativePattern(ctx: ToolContext, filePath: string) {
  const resolved = path.resolve(ctx.sandbox.root, filePath)
  return ctx.sandbox.contains(resolved) ? path.relative(ctx.sandbox.root, resolved) || "." : resolved
}

type BashApproval = {
  target: string
  rememberPatterns: string[]
  label: string
  repeatSafe: boolean
}

const exactBashApprovalPrefix = "bash:exact:"

function bashApprovalForCommand(command: string, cwd = process.cwd()): BashApproval {
  const trimmed = command.trim()
  if (!trimmed) return exactBashApproval(trimmed)
  if (isDangerousCommand(trimmed)) return rawBashApproval(trimmed, false)
  const words = shellWords(trimmed)
  if (!words || words.length === 0) return exactBashApproval(trimmed)
  const [program = "", ...args] = words
  const normalizedProgram = path.basename(program)
  if (normalizedProgram === "git") return gitBashApproval(trimmed, args)
  if (normalizedProgram === "pwd") return scopedBashApproval("pwd", "project", [])
  if (!["ls", "cat", "wc", "find"].includes(normalizedProgram)) return exactBashApproval(trimmed)
  const pathArgs = args.filter((arg) => !arg.startsWith("-"))
  if (pathArgs.length > 1) return exactBashApproval(trimmed)
  const rawPath = pathArgs[0] ?? "."
  const resolved = path.resolve(cwd, rawPath)
  return scopedBashApproval(normalizedProgram, normalizedPath(resolved), pathRememberPatterns(normalizedProgram, resolved))
}

function gitBashApproval(command: string, args: string[]) {
  const subcommand = args.find((arg) => !arg.startsWith("-"))
  if (!subcommand || !["status", "diff", "log"].includes(subcommand)) return exactBashApproval(command)
  return scopedBashApproval(`git:${subcommand}`, "project", [])
}

function exactBashApproval(command: string): BashApproval {
  return {
    target: `${exactBashApprovalPrefix}${command}`,
    rememberPatterns: [`${exactBashApprovalPrefix}${command}`],
    label: "exact command",
    repeatSafe: true,
  }
}

function rawBashApproval(command: string, repeatSafe: boolean): BashApproval {
  return {
    target: command,
    rememberPatterns: [command],
    label: "raw command",
    repeatSafe,
  }
}

function scopedBashApproval(kind: string, scope: string, rememberPatterns: string[]): BashApproval {
  const target = `bash:readonly:${kind}:${scope}`
  const labelScope = rememberPatterns.length > 0 ? rememberPatterns.map((pattern) => pattern.replace(`bash:readonly:${kind}:`, "")).join(", ") : scope
  return {
    target,
    rememberPatterns: rememberPatterns.length > 0 ? rememberPatterns : [target],
    label: `readonly ${kind} ${labelScope}`,
    repeatSafe: true,
  }
}

function pathRememberPatterns(kind: string, resolved: string) {
  const normalized = normalizedPath(resolved)
  const parent = normalizedPath(path.dirname(resolved))
  const patterns = new Set([`bash:readonly:${kind}:${normalized}`])
  if (kind === "ls") patterns.add(`bash:readonly:${kind}:${parent}/*`)
  if (pathLooksDirectory(resolved)) patterns.add(`bash:readonly:${kind}:${normalized}/*`)
  return [...patterns]
}

function pathLooksDirectory(filePath: string) {
  try {
    return statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function normalizedPath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
}

function shellWords(command: string) {
  if (/[;&><`$|]/.test(command)) return undefined
  const words: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (quote) return undefined
  if (current) words.push(current)
  return words
}

export function createBuiltinRegistry() {
  const registry = new ToolRegistry()

  registry.register({
    name: "read",
    description: "Read a file inside the project root.",
    inputSchema: ReadInput,
    jsonSchema: objectSchema({ filePath: { type: "string", description: "File path to read" } }),
    permission: "read",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, ReadInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = ReadInput.parse(input)
      return { title: params.filePath, output: await ctx.sandbox.readFile(params.filePath), metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "list",
    description: "List a directory inside the project root.",
    inputSchema: ListInput,
    jsonSchema: objectSchema({ dirPath: { type: "string", description: "Directory path" } }, []),
    permission: "list",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, ListInput.parse(input).dirPath ?? ".")],
    execute: async (input, ctx) => {
      const params = ListInput.parse(input)
      return { title: params.dirPath ?? ".", output: (await ctx.sandbox.list(params.dirPath)).join("\n"), metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "grep",
    description: "Fallback plain text search. For code exploration, use repo_map, find_definition, rg_search, and read_lines first; use grep only when semantic navigation or rg_search is unavailable.",
    inputSchema: GrepInput,
    jsonSchema: objectSchema({ query: { type: "string" }, dir: { type: "string" } }, ["query"]),
    permission: "grep",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, GrepInput.parse(input).dir ?? ".")],
    execute: async (input, ctx) => {
      const params = GrepInput.parse(input)
      return { title: params.query, output: (await ctx.sandbox.grep(params)).join("\n"), metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "rg_search",
    description: "Fast bounded code search with ripgrep. Prefer this over grep; provide dir or fileType when possible and keep maxResults small.",
    inputSchema: RgSearchInput,
    jsonSchema: objectSchema(
      {
        query: { type: "string", description: "Ripgrep query. Use precise symbols or escaped regex." },
        dir: { type: "string", description: "Optional project-relative directory to search." },
        fileType: { type: "string", description: "Optional file extension/type such as ts, tsx, js, py, or go." },
        maxResults: { type: "number", description: "Maximum matches to return. Defaults to 50 and is capped at 200." },
      },
      ["query"],
    ),
    permission: "grep",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, RgSearchInput.parse(input).dir ?? ".")],
    execute: async (input, ctx) => {
      const params = RgSearchInput.parse(input)
      const results = await new CliCodeNavigator(ctx.sandbox, { signal: ctx.signal }).rgSearch(params)
      return { title: params.query, output: formatSearchResults(results), metadata: { status: "succeeded", count: results.length } }
    },
  })

  registry.register({
    name: "read_lines",
    description: "Read a bounded 1-based line range from one project file. Use this after search/definition tools instead of reading whole large files.",
    inputSchema: ReadLinesInput,
    jsonSchema: objectSchema({
      filePath: { type: "string", description: "Project-relative file path." },
      startLine: { type: "number", description: "1-based start line." },
      endLine: { type: "number", description: "1-based inclusive end line. At most 200 lines may be read." },
    }),
    permission: "read",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, ReadLinesInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = ReadLinesInput.parse(input)
      const result = await new CliCodeNavigator(ctx.sandbox, { signal: ctx.signal }).readLines(params)
      return { title: `${result.filePath}:${result.startLine}-${result.endLine}`, output: result.content, metadata: { status: "succeeded", filePath: result.filePath, startLine: result.startLine, endLine: result.endLine } }
    },
  })

  registry.register({
    name: "find_definition",
    description: "Find class/function/interface/type/variable definitions with ast-grep. Fails clearly if ast-grep is unavailable; does not fall back to noisy full-text search.",
    inputSchema: FindDefinitionInput,
    jsonSchema: objectSchema(
      {
        symbol: { type: "string", description: "Identifier to locate." },
        language: { type: "string", description: "ast-grep language, defaults to typescript." },
        maxResults: { type: "number", description: "Maximum matches to return. Defaults to 50 and is capped at 200." },
      },
      ["symbol"],
    ),
    permission: "grep",
    modes: ["build", "plan"],
    patterns: () => ["."],
    execute: async (input, ctx) => {
      const params = FindDefinitionInput.parse(input)
      const results = await new CliCodeNavigator(ctx.sandbox, { signal: ctx.signal }).findDefinition(params)
      return { title: params.symbol, output: formatSearchResults(results), metadata: { status: "succeeded", count: results.length } }
    },
  })

  registry.register({
    name: "find_references",
    description: "Find bounded symbol references with ripgrep word matching. Use language to constrain file types and avoid noisy broad search.",
    inputSchema: FindReferencesInput,
    jsonSchema: objectSchema(
      {
        symbol: { type: "string", description: "Identifier to search as a whole word." },
        language: { type: "string", description: "Optional language hint such as typescript or javascript." },
        maxResults: { type: "number", description: "Maximum matches to return. Defaults to 50 and is capped at 200." },
      },
      ["symbol"],
    ),
    permission: "grep",
    modes: ["build", "plan"],
    patterns: () => ["."],
    execute: async (input, ctx) => {
      const params = FindReferencesInput.parse(input)
      const results = await new CliCodeNavigator(ctx.sandbox, { signal: ctx.signal }).findReferences(params)
      return { title: params.symbol, output: formatSearchResults(results), metadata: { status: "succeeded", count: results.length } }
    },
  })

  registry.register({
    name: "repo_map",
    description: "First-choice codebase orientation tool. Generate or read a cached lightweight code skeleton under .easycode/cache/repo-map.json. Use before grep/read when exploring code. Returns paths and symbols only, not function bodies.",
    inputSchema: RepoMapInput,
    jsonSchema: objectSchema(
      {
        dir: { type: "string", description: "Optional project-relative directory to map." },
        language: { type: "string", description: "Optional language filter such as typescript or javascript." },
        maxFiles: { type: "number", description: "Maximum source files to map. Defaults to 200." },
        useCache: { type: "boolean", description: "When false, force a rebuild of the derived cache." },
      },
      [],
    ),
    permission: "grep",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, RepoMapInput.parse(input).dir ?? ".")],
    execute: async (input, ctx) => {
      const params = RepoMapInput.parse(input)
      const map = await new CliCodeNavigator(ctx.sandbox, { signal: ctx.signal }).repoMap(params)
      return { title: `repo_map ${map.dir}`, output: formatRepoMap(map), metadata: { status: "succeeded", cacheHit: map.cache.hit, cachePath: map.cache.path, cacheGitIgnored: map.cache.gitIgnored, files: map.entries.length } }
    },
  })

  registry.register({
    name: "git_diff",
    description: "Inspect git changes without dumping full patches. Use summary/files/stat first; use mode=file with one filePath only when a focused patch is needed.",
    inputSchema: GitDiffInput,
    jsonSchema: objectSchema(
      {
        mode: { type: "string", description: "summary, files, stat, or file. Defaults to summary." },
        filePath: { type: "string", description: "Required only for mode=file. Project-relative path to inspect." },
        maxBytes: { type: "number", description: "Maximum patch bytes for mode=file. Defaults to 12000 and is capped at 30000." },
      },
      [],
    ),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:diff", "project", []).target],
    execute: async (input, ctx) => {
      const params = GitDiffInput.parse(input)
      return gitDiffToolResult(params, ctx)
    },
  })

  registry.register({
    name: "write",
    description: "Write a file inside the project root.",
    inputSchema: WriteInput,
    jsonSchema: objectSchema({ filePath: { type: "string" }, content: { type: "string" } }),
    permission: "write",
    modes: ["build"],
    patterns: (input, ctx) => [relativePattern(ctx, WriteInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = WriteInput.parse(input)
      await ctx.sandbox.writeFile(params.filePath, params.content)
      return { title: params.filePath, output: "Write applied successfully.", metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "edit",
    description: "Replace text in a file inside the project root. By default only the first match is replaced.",
    inputSchema: EditInput,
    jsonSchema: objectSchema(
      {
        filePath: { type: "string", description: "File path to edit" },
        oldString: { type: "string", description: "Text to replace" },
        newString: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "When true, replace every match instead of only the first match" },
      },
      ["filePath", "oldString", "newString"],
    ),
    permission: "edit",
    modes: ["build"],
    patterns: (input, ctx) => [relativePattern(ctx, EditInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = EditInput.parse(input)
      const current = await ctx.sandbox.readFile(params.filePath)
      if (!current.includes(params.oldString)) throw new Error(`oldString not found in ${params.filePath}`)
      const next = params.replaceAll ? current.split(params.oldString).join(params.newString) : current.replace(params.oldString, params.newString)
      await ctx.sandbox.writeFile(params.filePath, next)
      return { title: params.filePath, output: "Edit applied successfully.", metadata: { status: "succeeded", changed: params.filePath } }
    },
  })

  registry.register({
    name: "bash",
    description: "Run a shell command through the sandbox. Prefer specialized tools first: use git_diff for git diffs and repo_map/find_definition/rg_search/read_lines for code exploration.",
    inputSchema: BashInput,
    jsonSchema: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, ["command"]),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: (input, ctx) => {
      const params = BashInput.parse(input)
      return [bashApprovalForCommand(params.command, bashCwd(ctx, params.cwd)).target]
    },
    execute: async (input, ctx) => {
      const params = BashInput.parse(input)
      const result = await executeBashWithSandboxRecovery(params, ctx)
      return bashResultToToolResult(params.command, result)
    },
  })

  registry.register({
    name: "skill",
    description: "Load the full content of a named skill.",
    inputSchema: SkillInput,
    jsonSchema: objectSchema({ name: { type: "string" } }),
    permission: "skill",
    modes: ["build", "plan"],
    patterns: (input) => [SkillInput.parse(input).name],
    execute: async (input, ctx) => {
      const params = SkillInput.parse(input)
      const skill = await ctx.skills.load(params.name)
      if (!skill) return { title: params.name, output: `Skill not found: ${params.name}`, metadata: { status: "failed" } }
      return { title: `Loaded skill: ${skill.name}`, output: skill.content ?? "", metadata: { status: "succeeded", location: skill.location } }
    },
  })

  registry.register({
    name: "plan_exit",
    description: "Return the final proposed plan in plan mode.",
    inputSchema: PlanExitInput,
    jsonSchema: objectSchema({ markdown: { type: "string" } }),
    permission: "plan_exit",
    modes: ["plan"],
    patterns: () => ["*"],
    execute: async (input) => {
      const params = PlanExitInput.parse(input)
      return { title: "Plan", output: `<proposed_plan>\n${params.markdown.trim()}\n</proposed_plan>`, metadata: { status: "succeeded" } }
    },
  })

  return registry
}

function formatSearchResults(results: Array<{ filePath: string; line: number; preview: string }>) {
  if (results.length === 0) return "No matches."
  return results.map((result) => `${result.filePath}:${result.line}: ${result.preview}`).join("\n")
}

function formatRepoMap(map: { cache: { path: string; hit: boolean; gitIgnored: boolean }; entries: Array<{ filePath: string; symbols: Array<{ name: string; kind: string; line: number; signature?: string }> }> }) {
  const lines = [`cache=${map.cache.hit ? "hit" : "rebuilt"} path=${map.cache.path}`]
  if (!map.cache.gitIgnored) lines.push("warning: .easycode is not ignored by .gitignore; repo_map cache is a derived local artifact and should not be committed.")
  for (const entry of map.entries) {
    lines.push(`File: ${entry.filePath}`)
    if (entry.symbols.length === 0) {
      lines.push("  (no top-level symbols found)")
      continue
    }
    for (const symbol of entry.symbols) lines.push(`  ${symbol.kind} ${symbol.name} @ ${symbol.line}${symbol.signature ? ` :: ${symbol.signature}` : ""}`)
  }
  return lines.join("\n")
}

async function gitDiffToolResult(params: z.infer<typeof GitDiffInput>, ctx: ToolContext): Promise<ToolResult> {
  if (params.mode === "file" && !params.filePath) throw new Error("git_diff mode=file requires filePath")
  const maxBytes = clampInt(params.maxBytes ?? 12_000, 1_000, 30_000)
  const filePath = params.mode === "file" && params.filePath ? path.relative(ctx.sandbox.root, ctx.sandbox.resolve(params.filePath)).replaceAll(path.sep, "/") || "." : undefined
  const args = gitDiffArgs({ mode: params.mode, filePath })
  const result = await runGit(args, ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git diff failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`}`)
  const output = params.mode === "file" ? truncateText(result.stdout || "(no diff)", maxBytes) : result.stdout || "(no changes)"
  return {
    title: params.mode === "file" ? `git diff -- ${filePath}` : `git diff ${params.mode}`,
    output,
    metadata: {
      status: "succeeded",
      mode: params.mode,
      filePath,
      truncated: result.stdout.length > output.length,
    },
  }
}

function gitDiffArgs(params: { mode: z.infer<typeof GitDiffInput>["mode"]; filePath?: string }) {
  if (params.mode === "files") return ["diff", "--name-only"]
  if (params.mode === "stat") return ["diff", "--stat"]
  if (params.mode === "file") return ["diff", "--", params.filePath ?? ""]
  return ["diff", "--name-status", "--stat"]
}

async function runGit(args: string[], cwd: string, signal: AbortSignal | undefined) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", signal })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.catch(() => null),
  ])
  return { stdout, stderr, exitCode }
}

function truncateText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const buffer = Buffer.from(text)
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated ${buffer.length - maxBytes} bytes; use git_diff mode=file with a narrower file or inspect another file separately]`
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ""
}

function permissionRequestForTool(tool: ToolDef, input: unknown, ctx: ToolContext, patterns: string[]): Omit<PermissionRequest, "id"> {
  if (tool.name === "bash") {
    const params = BashInput.parse(input)
    const approval = bashApprovalForCommand(params.command, bashCwd(ctx, params.cwd))
    return {
      permission: tool.permission,
      patterns: [approval.target],
      always: approval.rememberPatterns,
      metadata: {
        tool: tool.name,
        command: params.command,
        approvalScope: approval.label,
        rememberOnApprove: approval.repeatSafe,
        rememberPatterns: approval.rememberPatterns,
      },
    }
  }
  return { permission: tool.permission, patterns, always: patterns, metadata: { tool: tool.name } }
}

function bashCwd(ctx: ToolContext, cwd: string | undefined) {
  try {
    return ctx.sandbox.resolve(cwd ?? ".")
  } catch {
    return ctx.sandbox.root
  }
}

async function executeBashWithSandboxRecovery(params: z.infer<typeof BashInput>, ctx: ToolContext) {
  const options: SandboxExecuteOptions = {}
  let result: BashResult
  try {
    result = await ctx.sandbox.execute(params, ctx.agentMode, { ...options, signal: ctx.signal })
  } catch (error) {
    if (!(error instanceof SandboxPathEscapeError)) throw error
    const approved = await requestSandboxBypass(ctx, params, {
      reason: "path_boundary_escape",
      risk: "Reruns this command without EasyCode's explicit project-root path boundary check. The command may read from or reference paths outside the project root.",
      failure: error.message,
      reference: error.reference,
      resolved: error.resolved,
    })
    if (!approved) throw error
    options.bypassPathBoundary = true
    result = await ctx.sandbox.execute(params, ctx.agentMode, { ...options, signal: ctx.signal })
  }
  if (!looksLikeNativeSandboxDenial(result)) return result

  const approved = await requestSandboxBypass(ctx, params, {
    reason: "native_write_sandbox_denial",
    risk: "Reruns this command without the macOS write sandbox. The command may write outside the project root, including temp, cache, or home directories.",
    failure: sandboxFailureSummary(result),
  })
  if (!approved) {
    return { ...result, stderr: appendLine(result.stderr, "Sandbox bypass was not approved; command was not retried.") }
  }

  const retried = await ctx.sandbox.execute(params, ctx.agentMode, { ...options, bypassNativeWriteSandbox: true, signal: ctx.signal })
  return { ...retried, stderr: retried.stderr, sandboxBypassed: true }
}

async function requestSandboxBypass(ctx: ToolContext, params: z.infer<typeof BashInput>, metadata: Record<string, unknown>) {
  const reason = typeof metadata.reason === "string" ? metadata.reason : "sandbox_bypass"
  const approval = sandboxBypassApproval(reason, params.command, bashCwd(ctx, params.cwd))
  try {
    await ctx.permission.authorize({
      permission: "sandbox_bypass",
      patterns: [approval.target],
      always: approval.rememberPatterns,
      metadata: {
        tool: "bash",
        command: params.command,
        cwd: params.cwd,
        approvalScope: approval.label,
        rememberOnApprove: true,
        rememberPatterns: approval.rememberPatterns,
        ...metadata,
      },
    })
    return true
  } catch {
    return false
  }
}

function sandboxBypassApproval(reason: string, command: string, cwd: string): BashApproval {
  if (reason === "path_boundary_escape") {
    const approval = bashApprovalForCommand(command, cwd)
    return {
      target: `${reason}:${approval.target}`,
      rememberPatterns: approval.rememberPatterns.map((pattern) => `${reason}:${pattern}`),
      label: `${reason} ${approval.label}`,
      repeatSafe: approval.repeatSafe,
    }
  }
  const exact = exactBashApproval(command)
  return {
    target: `${reason}:${exact.target}`,
    rememberPatterns: exact.rememberPatterns.map((pattern) => `${reason}:${pattern}`),
    label: `${reason} ${exact.label}`,
    repeatSafe: true,
  }
}

function bashResultToToolResult(command: string, result: BashResult): ToolResult {
  const { stdout, stderr, ...metadata } = result
  const output = [stdout, stderr, result.cancelled && !stdout && !stderr ? "Command cancelled by user." : ""].filter(Boolean).join("\n")
  return { title: command, output, metadata: { status: result.exitCode === 0 ? "succeeded" : "failed", ...metadata } }
}

function sandboxFailureSummary(result: BashResult) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 1_000)
}

function appendLine(text: string, line: string) {
  return text ? `${text}\n${line}` : line
}
