import { z } from "zod"
import { CliCodeNavigator } from "./code-navigator"
import { ToolRegistry } from "./registry"
import { BashInput, bashApprovalForCommand, bashCwd, bashResultToToolResult, executeBashWithSandboxRecovery, scopedBashApproval } from "./bash"
import { EditInput, FindDefinitionInput, FindReferencesInput, GrepInput, ListInput, ReadInput, ReadLinesInput, RepoMapInput, RgSearchInput, WriteInput, countLines, formatRepoMap, formatSearchResults, maxFullReadLines, relativePattern } from "./fs"
import { GitDiffInput, gitDiffToolResult } from "./git"
import type { JsonSchema } from "./registry"

function objectSchema(properties: JsonSchema["properties"], required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

const SkillInput = z.object({ name: z.string() })
const PlanExitInput = z.object({ markdown: z.string() })

export function createBuiltinRegistry() {
  const registry = new ToolRegistry()

  registry.register({
    name: "read",
    description: "Read a small file inside the project root. For code exploration, large files are blocked; use repo_map, find_definition or rg_search, then read_lines.",
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
          output: `Full-file read blocked for ${params.filePath}: ${lineCount} lines exceeds the ${maxFullReadLines}-line limit. Use repo_map first, then find_definition or rg_search to locate the symbol, then read_lines for the smallest relevant range.`,
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
    description: "First-choice codebase orientation tool. Generate or read a cached lightweight code skeleton under .easycode/cache/repo-map.json. The backing code-index cache is tool-private and must never be returned wholesale to model context. Use before grep/read when exploring code. Returns paths and symbols only, not function bodies. Supports optional query parameter to dynamically filter and slice symbols by relevance.",
    inputSchema: RepoMapInput,
    jsonSchema: objectSchema(
      {
        dir: { type: "string", description: "Optional project-relative directory to map." },
        language: { type: "string", description: "Optional language filter such as typescript or javascript." },
        maxFiles: { type: "number", description: "Maximum source files to map. Defaults to 200." },
        useCache: { type: "boolean", description: "When false, force a rebuild of the derived cache." },
        query: { type: "string", description: "Optional semantic keyword query to filter symbols and files (e.g. 'payment', 'retry')." },
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
