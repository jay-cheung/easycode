import { McpSourceService, WebSearchService, formatMcpResource, formatMcpResources, formatWebResults, mcpCitation, webCitation } from "../../retrieval"
import { SkillInput, PlanExitInput, McpListResourcesInput, McpReadResourceInput, WebSearchInput, objectSchema } from "./common"
import type { ToolRegistry } from "../registry"

export function registerRetrievalTools(registry: ToolRegistry) {
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
}
