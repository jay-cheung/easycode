import { CliCodeNavigator } from "../code-navigator"
import { CallGraphInput, GrepInput, ListInput, ReadInput, ReadLinesInput, RepoMapInput, RgSearchInput, FindDefinitionInput, FindReferencesInput, countLines, formatCallGraph, formatRepoMap, formatSearchResults, maxFullReadLines, relativePattern } from "../fs"
import type { ToolRegistry } from "../registry"
import { objectSchema } from "./common"

export function registerCodeTools(registry: ToolRegistry) {
  registry.register({
    name: "read",
    description: "Read a small project file only after the target file is already narrowed. Prefer repo_map, find_definition/find_references/call_graph, and read_lines first; large files are blocked.",
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
    description: "Last-resort plain text search. Use only when semantic navigation or rg_search cannot express the need, such as non-code text or broad prose/config scans.",
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
    description: "Fast bounded text/regex search. Prefer this over grep for exact strings, log text, literals, or file-local text patterns, but use semantic tools first for symbol definitions/references/callers.",
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
    description: "Read the smallest exact 1-based line range after repo_map, symbol lookup, call_graph, or rg_search has identified the target location.",
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
    description: "Primary semantic definition lookup. Use this before rg_search or grep when you need the owning definition of a function, class, type, method, or exported symbol. Accepts a name, qualified name, or symbol id.",
    inputSchema: FindDefinitionInput,
    jsonSchema: objectSchema(
      {
        symbol: { type: "string", description: "Name, qualified name, or id." },
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
    description: "Primary semantic reference lookup. Use this before rg_search or grep when you need usages of a symbol. Accepts a name, qualified name, or symbol id; prefer qualified name or id to disambiguate same-name symbols.",
    inputSchema: FindReferencesInput,
    jsonSchema: objectSchema(
      {
        symbol: { type: "string", description: "Name, qualified name, or id." },
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
    description: "Primary caller/callee exploration tool. Use this before grep or bash for impact analysis, who-calls-what questions, imported alias resolution, or bounded call-path tracing.",
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
    description: "First-choice code exploration entrypoint. Use with query to shortlist relevant files and top-level symbols before any reads. Returns paths/symbol skeletons only, not full file content.",
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
}
