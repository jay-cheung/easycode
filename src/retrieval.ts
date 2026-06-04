import path from "node:path"
import { z } from "zod"
import { easycodeDir } from "./easycode-path"
import { getTlsConfig } from "./tls-config"
import { clampLimit, formatMcpResource, formatMcpResources, formatWebResults, mcpCitation, rankResources, rankWebResults, webCitation } from "./retrieval-format"
import { apiKeyFor, headersFor, normalizeEngine, parseEngineResults, requestFor } from "./retrieval-live"
import { selectEngine, withImplicitDefaults } from "./retrieval-config"

const webSearchEnvHint = "Set it in ~/.easycode/.env or your shell environment."
export const tavilySetupHint = `Configure Tavily with TAVILY_API_KEY. ${webSearchEnvHint}`

const McpResource = z.object({
  uri: z.string(),
  title: z.string(),
  description: z.string().optional(),
  text: z.string().optional(),
})

const McpServer = z.object({
  name: z.string(),
  resources: z.array(McpResource).default([]),
})

const McpConfig = z.object({
  servers: z.array(McpServer).default([]),
})

const WebSearchResult = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  source: z.string().optional(),
  retrievedAt: z.string().optional(),
})

const SearchPrimitive = z.union([z.string(), z.number(), z.boolean()])

const WebSearchEngine = z.object({
  name: z.string(),
  type: z.string().default("tavily"),
  endpoint: z.string().optional(),
  method: z.enum(["GET", "POST"]).optional(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyHeader: z.string().optional(),
  apiKeyPrefix: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  queryParam: z.string().optional(),
  limitParam: z.string().optional(),
  resultsPath: z.string().optional(),
  titlePath: z.string().optional(),
  urlPath: z.string().optional(),
  snippetPath: z.string().optional(),
  sourcePath: z.string().optional(),
  extraParams: z.record(z.string(), SearchPrimitive).default({}),
  timeoutMs: z.number().optional(),
})

const WebSearchConfig = z.object({
  defaultEngine: z.string().optional(),
  engines: z.array(WebSearchEngine).default([]),
  results: z.array(WebSearchResult).default([]),
})

export type McpResource = z.infer<typeof McpResource> & { server: string }
export type WebSearchResult = z.infer<typeof WebSearchResult>
export type WebSearchEngine = z.infer<typeof WebSearchEngine>

export type WebSearchResponse = {
  results: WebSearchResult[]
  live: boolean
  engine?: string
  warning?: string
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type CitedSource = {
  type: "mcp" | "web"
  id: string
  title: string
  uri?: string
  url?: string
  retrievedAt: string
}

export class McpSourceService {
  readonly configPath: string

  constructor(root: string) {
    this.configPath = path.join(easycodeDir(root), "mcp.json")
  }

  async listResources(query?: string, limit = 10) {
    const config = await this.load()
    const resources = config.servers.flatMap((server) => server.resources.map((resource) => ({ ...resource, server: server.name })))
    return rankResources(resources, query).slice(0, clampLimit(limit))
  }

  async readResource(uri: string, serverName?: string) {
    const resources = await this.listResources(undefined, 1000)
    return resources.find((resource) => resource.uri === uri && (!serverName || resource.server === serverName))
  }

  private async load() {
    const file = Bun.file(this.configPath)
    if (!(await file.exists())) return { servers: [] as z.infer<typeof McpServer>[] }
    return McpConfig.parse(JSON.parse(await file.text()))
  }
}

export class WebSearchService {
  readonly configPath: string

  constructor(
    root: string,
    private readonly options: { fetch?: FetchLike; env?: Record<string, string | undefined> } = {},
  ) {
    this.configPath = path.join(easycodeDir(root), "websearch.json")
  }

  async search(query: string, limit = 5, options: { engine?: string; live?: boolean; signal?: AbortSignal } = {}): Promise<WebSearchResponse> {
    const file = Bun.file(this.configPath)
    const loaded = (await file.exists()) ? WebSearchConfig.parse(JSON.parse(await file.text())) : WebSearchConfig.parse({})
    const config = withImplicitDefaults(loaded, this.options.env ?? process.env, WebSearchEngine.parse)
    const selectedEngineName = options.engine ?? config.defaultEngine
    const engine = selectEngine(config.engines, selectedEngineName)
    if (options.engine && !engine) throw new Error(`web search engine not found: ${options.engine}`)
    if (config.defaultEngine && !engine && options.live !== false) throw new Error(`web search default engine not found: ${config.defaultEngine}`)
    if (options.live === true && !engine) {
      throw new Error(`live web search requires a configured engine. ${tavilySetupHint}`)
    }
    const shouldSearchLive = options.live ?? Boolean(engine && selectedEngineName)
    if (engine && shouldSearchLive) {
      return { results: await this.searchLive(engine, query, limit, options.signal), live: true, engine: engine.name }
    }
    return {
      results: rankWebResults(config.results, query).slice(0, clampLimit(limit)),
      live: false,
      engine: engine?.name,
      warning: engine && !shouldSearchLive ? "live search disabled by request" : undefined,
    }
  }

  private async searchLive(engine: WebSearchEngine, query: string, limit: number, signal?: AbortSignal) {
    const normalized = normalizeEngine(engine, tavilySetupHint)
    const apiKey = apiKeyFor(normalized, this.options.env ?? process.env, webSearchEnvHint)
    const headers = headersFor(normalized, apiKey)
    const request = requestFor(normalized, query, clampLimit(limit), headers, signal)
    const fetcher = this.options.fetch ?? fetch

    const tlsConfig = getTlsConfig()
    if (tlsConfig && !this.options.fetch) {
      (request.init as any).tls = tlsConfig
    }

    try {
      const response = await fetcher(request.url, request.init)
      if (!response.ok) throw new Error(`web search ${normalized.name} failed: HTTP ${response.status}`)
      const payload = await response.json() as unknown
      return parseEngineResults(payload, normalized).slice(0, clampLimit(limit))
    } finally {
      request.cleanup()
    }
  }
}

export async function hasConfiguredWebSearch(root: string, env: Record<string, string | undefined> = process.env) {
  if (env.TAVILY_API_KEY) return true
  const file = Bun.file(path.join(easycodeDir(root), "websearch.json"))
  if (!(await file.exists())) return false
  try {
    const config = WebSearchConfig.parse(JSON.parse(await file.text()))
    if (config.defaultEngine !== "tavily") return false
    const engine = selectEngine(config.engines, "tavily")
    if (!engine) return false
    if (engine.apiKey) return true
    if (engine.apiKeyEnv) return Boolean(env[engine.apiKeyEnv])
    return false
  } catch {
    return false
  }
}

export { clampLimit, formatMcpResource, formatMcpResources, formatWebResults, mcpCitation, webCitation }
