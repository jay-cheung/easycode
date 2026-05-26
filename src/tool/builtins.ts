import { z } from "zod"
import { CliCodeNavigator } from "./code-navigator"
import { ToolRegistry } from "./registry"
import { BashInput, bashApprovalForCommand, bashCwd, bashResultToToolResult, executeBashWithSandboxRecovery, scopedBashApproval } from "./bash"
import { CallGraphInput, EditInput, FindDefinitionInput, FindReferencesInput, GrepInput, ListInput, ReadInput, ReadLinesInput, RepoMapInput, RgSearchInput, WriteInput, countLines, formatCallGraph, formatRepoMap, formatSearchResults, maxFullReadLines, relativePattern } from "./fs"
import { GitDiffInput, gitDiffToolResult } from "./git"
import type { JsonSchema } from "./registry"

function objectSchema(properties: JsonSchema["properties"], required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

const SkillInput = z.object({ name: z.string() })
const PlanExitInput = z.object({ markdown: z.string() })
const LedgerInput = z.object({ query: z.string().optional() })

export function createBuiltinRegistry() {
  const registry = new ToolRegistry()

  registry.register({
    name: "read",
    description: "Read a small project file; large files are blocked.",
    inputSchema: ReadInput,
    jsonSchema: objectSchema({ filePath: { type: "string", description: "File path to read" } }),
    permission: "read",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, ReadInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = ReadInput.parse(input)
      const output = await ctx.sandbox.readFile(params.filePath)
      const lineCount = countLines(output)
      if (lineCount > maxFullReadLines) {
        return {
          title: params.filePath,
          output: `Full-file read blocked for ${params.filePath}: ${lineCount} lines exceeds ${maxFullReadLines}. Use repo_map, search/call_graph, then read_lines.`,
          metadata: { status: "failed", error: "large_file_read_forbidden", lineCount, maxLines: maxFullReadLines },
        }
      }
      return { title: params.filePath, output, metadata: { status: "succeeded", lineCount } }
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
    description: "Fallback plain text search.",
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
    description: "Fast bounded ripgrep search.",
    inputSchema: RgSearchInput,
    jsonSchema: objectSchema(
      {
        query: { type: "string", description: "Regex or text query." },
        dir: { type: "string", description: "Project-relative dir." },
        fileType: { type: "string", description: "Extension/type." },
        maxResults: { type: "number", description: "Max matches." },
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
    description: "Read a bounded 1-based line range.",
    inputSchema: ReadLinesInput,
    jsonSchema: objectSchema({
      filePath: { type: "string", description: "Project-relative path." },
      startLine: { type: "number", description: "Start line." },
      endLine: { type: "number", description: "End line, max 200 lines." },
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
    description: "Find symbol definitions via code index, then fallback.",
    inputSchema: FindDefinitionInput,
    jsonSchema: objectSchema(
      {
        symbol: { type: "string", description: "Identifier." },
        language: { type: "string", description: "Language hint." },
        maxResults: { type: "number", description: "Max matches." },
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
    description: "Find bounded symbol references.",
    inputSchema: FindReferencesInput,
    jsonSchema: objectSchema(
      {
        symbol: { type: "string", description: "Identifier." },
        language: { type: "string", description: "Language hint." },
        maxResults: { type: "number", description: "Max matches." },
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
    name: "call_graph",
    description: "Inspect bounded callers/callees.",
    inputSchema: CallGraphInput,
    jsonSchema: objectSchema(
      {
        symbol: { type: "string", description: "Name, qualified name, or id." },
        direction: { type: ["string", "null"], enum: ["callers", "callees", "both", null], description: "callers/callees/both." },
        depth: { type: "number", description: "Depth, default 2, max 4." },
        language: { type: "string", description: "Optional language hint." },
        maxResults: { type: "number", description: "Max call edges." },
      },
      ["symbol", "direction", "depth", "language", "maxResults"],
    ),
    permission: "grep",
    modes: ["build", "plan"],
    patterns: () => ["."],
    execute: async (input, ctx) => {
      const params = CallGraphInput.parse(input)
      const graph = await new CliCodeNavigator(ctx.sandbox, { signal: ctx.signal }).callGraph(params)
      return { title: params.symbol, output: formatCallGraph(graph), metadata: { status: "succeeded", nodes: graph.nodes.length, edges: graph.edges.length } }
    },
  })

  registry.register({
    name: "repo_map",
    description: "First-choice codebase map. Returns paths/symbols only; use query.",
    inputSchema: RepoMapInput,
    jsonSchema: objectSchema(
      {
        dir: { type: "string", description: "Project-relative dir." },
        language: { type: "string", description: "Language filter." },
        maxFiles: { type: "number", description: "Max source files." },
        useCache: { type: "boolean", description: "False forces rebuild." },
        query: { type: "string", description: "Filter query." },
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
    name: "ledger",
    description: "Pull the current structured context ledger only when the user asks to confirm progress or execute/continue a task and the current state is unclear, or when you are unsure about the active objective, status, or next step. Do not call this on every turn.",
    inputSchema: LedgerInput,
    jsonSchema: objectSchema({ query: { type: "string", description: "Optional reason or keyword for pulling the ledger." } }, []),
    permission: "read",
    modes: ["build", "plan"],
    patterns: () => ["context_ledger"],
    execute: async (_input, ctx) => {
      const output = ctx.context?.selectedLedgerText() ?? ""
      return {
        title: "context ledger",
        output: output || "No context ledger records.",
        metadata: { status: "succeeded", empty: output.length === 0 },
      }
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
    description: "Finish plan mode with the final recommended markdown plan after read-only investigation. Use this instead of ending with ordinary prose when the plan is ready for user approval.",
    inputSchema: PlanExitInput,
    jsonSchema: objectSchema({ markdown: { type: "string" } }),
    permission: "plan_exit",
    modes: ["plan", "build"],
    patterns: () => ["*"],
    execute: async (input) => {
      const params = PlanExitInput.parse(input)
      return { title: "Plan", output: `<proposed_plan>\n${params.markdown.trim()}\n</proposed_plan>`, metadata: { status: "succeeded" } }
    },
  })

  return registry
}
