import { z } from "zod"
import { ConnectorService } from "../connector"
import { ProjectMemoryStore } from "../memory"
import { McpSourceService, WebSearchService, formatMcpResource, formatMcpResources, formatWebResults, mcpCitation, webCitation } from "../retrieval"
import { CliCodeNavigator } from "./code-navigator"
import { ToolRegistry } from "./registry"
import { BashInput, bashApprovalForCommand, bashCwd, bashResultToToolResult, executeBashWithSandboxRecovery, scopedBashApproval } from "./bash"
import { CallGraphInput, EditInput, FindDefinitionInput, FindReferencesInput, GrepInput, ListInput, PatchInput, ReadInput, ReadLinesInput, RepoMapInput, RgSearchInput, WriteInput, countLines, formatCallGraph, formatRepoMap, formatSearchResults, maxFullReadLines, relativePattern } from "./fs"
import { GitBranchInput, GitCommitInput, GitDiffInput, GitLogInput, GitRestoreInput, GitStageInput, GitStatusInput, gitBranchToolResult, gitCommitToolResult, gitDiffToolResult, gitLogToolResult, gitRestoreToolResult, gitStageToolResult, gitStatusToolResult } from "./git"
import type { JsonSchema, ToolDef } from "./registry"

function objectSchema(properties: JsonSchema["properties"], required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

const SkillInput = z.object({ name: z.string() })
const PlanExitInput = z.object({ markdown: z.string() })
const LedgerInput = z.object({ query: z.string().optional() })
const MemoryQueryInput = z.object({ query: z.string(), maxResults: z.number().nullish().transform((value) => value ?? 5) })
const MemoryAddInput = z.object({ text: z.string(), tags: z.array(z.string()).nullish().transform((value) => value ?? []) })
const ConnectorListInput = z.object({})
const ConnectorCallInput = z.object({ name: z.string() })
const McpListResourcesInput = z.object({ query: z.string().optional(), limit: z.number().nullish().transform((value) => value ?? 10) })
const McpReadResourceInput = z.object({ uri: z.string(), server: z.string().optional() })
const WebSearchInput = z.object({ query: z.string(), limit: z.number().nullish().transform((value) => value ?? 5), engine: z.string().optional(), live: z.boolean().optional() })

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
    name: "git_status",
    description: "Inspect git status without full patches.",
    inputSchema: GitStatusInput,
    jsonSchema: objectSchema({ short: { type: "boolean", description: "Use short branch status." } }, []),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:status", "project", []).target],
    execute: async (input, ctx) => gitStatusToolResult(GitStatusInput.parse(input), ctx),
  })

  registry.register({
    name: "git_stage",
    description: "Stage only explicit project files.",
    inputSchema: GitStageInput,
    jsonSchema: objectSchema({ files: { type: "array", items: { type: "string" }, description: "Project-relative files to stage." } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("git:stage", "explicit-files", []).target],
    execute: async (input, ctx) => gitStageToolResult(GitStageInput.parse(input), ctx),
  })

  registry.register({
    name: "git_commit",
    description: "Stage and commit only explicit files; refuses unrelated staged files.",
    inputSchema: GitCommitInput,
    jsonSchema: objectSchema({ message: { type: "string" }, files: { type: "array", items: { type: "string" } } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("git:commit", "explicit-files", []).target],
    execute: async (input, ctx) => gitCommitToolResult(GitCommitInput.parse(input), ctx),
  })

  registry.register({
    name: "git_branch",
    description: "Show current branch or create one explicitly.",
    inputSchema: GitBranchInput,
    jsonSchema: objectSchema({ name: { type: "string" }, create: { type: "boolean" }, startPoint: { type: "string" } }, []),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:branch", "project", []).target],
    execute: async (input, ctx) => gitBranchToolResult(GitBranchInput.parse(input), ctx),
  })

  registry.register({
    name: "git_log",
    description: "Inspect recent commit history.",
    inputSchema: GitLogInput,
    jsonSchema: objectSchema({ limit: { type: "number", description: "Maximum commits, capped at 50." } }, []),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:log", "project", []).target],
    execute: async (input, ctx) => gitLogToolResult(GitLogInput.parse(input), ctx),
  })

  registry.register({
    name: "git_restore_guarded",
    description: "Restore only explicit files from index or worktree.",
    inputSchema: GitRestoreInput,
    jsonSchema: objectSchema({ files: { type: "array", items: { type: "string" } }, staged: { type: "boolean" }, worktree: { type: "boolean" } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("git:restore", "explicit-files", []).target],
    execute: async (input, ctx) => gitRestoreToolResult(GitRestoreInput.parse(input), ctx),
  })

  registry.register({
    name: "patch",
    description: "Apply explicit multi-operation file patches inside the project root. Supports replace, create, delete, and move operations.",
    inputSchema: PatchInput,
    jsonSchema: objectSchema({
      operations: {
        type: "array",
        description: "Patch operations. Each item has type replace/create/delete/move and the required paths/content for that operation.",
        items: { type: "object" },
      },
    }),
    permission: "edit",
    modes: ["build"],
    patterns: (input, ctx) => patchPatterns(PatchInput.parse(input), ctx),
    execute: async (input, ctx) => {
      const params = PatchInput.parse(input)
      const changed: string[] = []
      for (const operation of params.operations) {
        if (operation.type === "replace") {
          const current = await ctx.sandbox.readFile(operation.filePath)
          if (!current.includes(operation.oldString)) throw new Error(`oldString not found in ${operation.filePath}`)
          const next = operation.replaceAll ? current.split(operation.oldString).join(operation.newString) : current.replace(operation.oldString, operation.newString)
          await ctx.sandbox.writeFile(operation.filePath, next)
          changed.push(operation.filePath)
        }
        if (operation.type === "create") {
          if (!operation.overwrite && await Bun.file(ctx.sandbox.resolve(operation.filePath)).exists()) throw new Error(`Refusing to overwrite existing file: ${operation.filePath}`)
          await ctx.sandbox.writeFile(operation.filePath, operation.content)
          changed.push(operation.filePath)
        }
        if (operation.type === "delete") {
          await ctx.sandbox.deleteFile(operation.filePath)
          changed.push(operation.filePath)
        }
        if (operation.type === "move") {
          await ctx.sandbox.moveFile(operation.fromPath, operation.toPath)
          changed.push(`${operation.fromPath} -> ${operation.toPath}`)
        }
      }
      return { title: "patch", output: changed.map((item) => `changed ${item}`).join("\n"), metadata: { status: "succeeded", changed, operations: params.operations.length } }
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
    name: "memory_query",
    description: "Query short project memory records for cross-session task state.",
    inputSchema: MemoryQueryInput,
    jsonSchema: objectSchema({ query: { type: "string" }, maxResults: { type: "number" } }),
    permission: "read",
    modes: ["build", "plan"],
    patterns: () => [".easycode/memory.json"],
    execute: async (input, ctx) => {
      const params = MemoryQueryInput.parse(input)
      const records = await new ProjectMemoryStore(ctx.sandbox.root).query(params.query, params.maxResults)
      return { title: "project memory", output: records.map((record) => `${record.id} [${record.tags.join(",")}]: ${record.text}`).join("\n") || "No matching memory records.", metadata: { status: "succeeded", count: records.length } }
    },
  })

  registry.register({
    name: "memory_add",
    description: "Add a short project memory record. Do not store secrets or raw logs.",
    inputSchema: MemoryAddInput,
    jsonSchema: objectSchema({ text: { type: "string" }, tags: { type: "array", items: { type: "string" } } }),
    permission: "write",
    modes: ["build"],
    patterns: () => [".easycode/memory.json"],
    execute: async (input, ctx) => {
      const params = MemoryAddInput.parse(input)
      const record = await new ProjectMemoryStore(ctx.sandbox.root).add({ text: params.text, tags: params.tags })
      return { title: "project memory", output: `Added ${record.id}`, metadata: { status: "succeeded", id: record.id, tags: record.tags } }
    },
  })

  registry.register({
    name: "connector_list",
    description: "List locally configured external connector tools from .easycode/connectors.json.",
    inputSchema: ConnectorListInput,
    jsonSchema: objectSchema({}, []),
    permission: "read",
    modes: ["build", "plan"],
    patterns: () => [".easycode/connectors.json"],
    execute: async (_input, ctx) => {
      const tools = await new ConnectorService(ctx.sandbox.root).list()
      return { title: "connectors", output: tools.map((tool) => `${tool.name}: ${tool.description}`).join("\n") || "No connectors configured.", metadata: { status: "succeeded", count: tools.length } }
    },
  })

  registry.register({
    name: "connector_call",
    description: "Call one locally configured connector command. Connector commands are static and require bash permission.",
    inputSchema: ConnectorCallInput,
    jsonSchema: objectSchema({ name: { type: "string" } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("connector", "configured-command", []).target],
    execute: async (input, ctx) => {
      const params = ConnectorCallInput.parse(input)
      const { tool, result } = await new ConnectorService(ctx.sandbox.root).call(params.name, ctx.sandbox, ctx.signal)
      return { title: tool.name, output: bashResultToToolResult(tool.command, result).output, metadata: { ...bashResultToToolResult(tool.command, result).metadata, connector: tool.name } }
    },
  })

  registry.register({
    name: "mcp_list_resources",
    description: "List configured MCP-style resources from .easycode/mcp.json. Use before mcp_read_resource when source uri is unknown.",
    inputSchema: McpListResourcesInput,
    jsonSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" } }, []),
    permission: "mcp",
    modes: ["build", "plan"],
    patterns: () => [".easycode/mcp.json"],
    execute: async (input, ctx) => {
      const startedAt = Date.now()
      const params = McpListResourcesInput.parse(input)
      const resources = await new McpSourceService(ctx.sandbox.root).listResources(params.query, params.limit)
      return {
        title: "MCP resources",
        output: formatMcpResources(resources),
        metadata: { status: "succeeded", query: params.query, count: resources.length, elapsedMs: Date.now() - startedAt, sources: resources.map(mcpCitation) },
      }
    },
  })

  registry.register({
    name: "mcp_read_resource",
    description: "Read one configured MCP-style resource by URI with structured citation metadata.",
    inputSchema: McpReadResourceInput,
    jsonSchema: objectSchema({ uri: { type: "string" }, server: { type: "string" } }, ["uri"]),
    permission: "mcp",
    modes: ["build", "plan"],
    patterns: (input) => {
      const params = McpReadResourceInput.parse(input)
      return [`.easycode/mcp.json`, `mcp:${params.server ?? "*"}:${params.uri}`]
    },
    execute: async (input, ctx) => {
      const startedAt = Date.now()
      const params = McpReadResourceInput.parse(input)
      const resource = await new McpSourceService(ctx.sandbox.root).readResource(params.uri, params.server)
      if (!resource) return { title: "MCP resource", output: `MCP resource not found: ${params.uri}`, metadata: { status: "failed", uri: params.uri } }
      const citation = mcpCitation(resource)
      return {
        title: resource.title,
        output: formatMcpResource(resource),
        metadata: { status: "succeeded", elapsedMs: Date.now() - startedAt, source: citation, sources: [citation] },
      }
    },
  })

  registry.register({
    name: "web_search",
    description: "Search web evidence. Uses Tavily live search when configured in .easycode/websearch.json or via TAVILY_API_KEY, otherwise searches fixture results.",
    inputSchema: WebSearchInput,
    jsonSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" }, engine: { type: "string" }, live: { type: "boolean" } }, ["query"]),
    permission: "web_search",
    modes: ["build", "plan"],
    patterns: (input) => [`web:${WebSearchInput.parse(input).query}`],
    execute: async (input, ctx) => {
      const startedAt = Date.now()
      const params = WebSearchInput.parse(input)
      const response = await new WebSearchService(ctx.sandbox.root).search(params.query, params.limit, { engine: params.engine, live: params.live, signal: ctx.signal })
      return {
        title: params.query,
        output: formatWebResults(response.results),
        metadata: { status: "succeeded", query: params.query, engine: response.engine, count: response.results.length, elapsedMs: Date.now() - startedAt, sources: response.results.map(webCitation), live: response.live, warning: response.warning },
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
    modes: ["plan"],
    patterns: () => ["*"],
    execute: async (input) => {
      const params = PlanExitInput.parse(input)
      return { title: "Plan", output: `<proposed_plan>\n${params.markdown.trim()}\n</proposed_plan>`, metadata: { status: "succeeded" } }
    },
  })

  return registry
}

function patchPatterns(input: z.infer<typeof PatchInput>, ctx: Parameters<ToolDef["patterns"]>[1]) {
  return input.operations.flatMap((operation) => {
    if (operation.type === "move") return [relativePattern(ctx, operation.fromPath), relativePattern(ctx, operation.toPath)]
    return [relativePattern(ctx, operation.filePath)]
  })
}
