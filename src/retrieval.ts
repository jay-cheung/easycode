import path from "node:path"
import { z } from "zod"
import { easycodeDir } from "./easycode-path"
import { getTlsConfig } from "./tls-config"

const webSearchEnvHint = "Set it in the repo root .env or your shell environment."
const tavilySetupHint = `Configure Tavily with TAVILY_API_KEY. ${webSearchEnvHint}`

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
  type: z.enum(["brave", "google", "tavily", "custom"]).default("custom"),
  endpoint: z.string().optional(),
  method: z.enum(["GET", "POST"]).optional(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyHeader: z.string().optional(),
  apiKeyParam: z.string().optional(),
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
    const config = withImplicitDefaults(loaded, this.options.env ?? process.env)
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
    const normalized = normalizeEngine(engine)
    const apiKey = apiKeyFor(normalized, this.options.env ?? process.env)
    const headers = headersFor(normalized, apiKey)
    const request = requestFor(normalized, query, clampLimit(limit), headers, apiKey, signal)
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

export function mcpCitation(resource: McpResource): CitedSource {
  return {
    type: "mcp",
    id: `${resource.server}:${resource.uri}`,
    title: resource.title,
    uri: resource.uri,
    retrievedAt: new Date().toISOString(),
  }
}

export function webCitation(result: WebSearchResult): CitedSource {
  return {
    type: "web",
    id: result.url,
    title: result.title,
    url: result.url,
    retrievedAt: result.retrievedAt ?? new Date().toISOString(),
  }
}

export function formatMcpResources(resources: McpResource[]) {
  if (resources.length === 0) return "No MCP resources found."
  return resources.map((resource, index) => {
    const description = resource.description ? `\nsummary: ${resource.description}` : ""
    return `[mcp:${index + 1}] ${resource.title}\nserver: ${resource.server}\nuri: ${resource.uri}${description}`
  }).join("\n\n")
}

export function formatMcpResource(resource: McpResource) {
  const description = resource.description ? `\nsummary: ${resource.description}` : ""
  const text = resource.text ? `\n\n${resource.text}` : ""
  return `[mcp] ${resource.title}\nserver: ${resource.server}\nuri: ${resource.uri}${description}${text}`
}

export function formatWebResults(results: WebSearchResult[]) {
  if (results.length === 0) return "No web search results found."
  return results.map((result, index) => {
    const retrievedAt = result.retrievedAt ? `\nretrievedAt: ${result.retrievedAt}` : ""
    const source = result.source ? `\nsource: ${result.source}` : ""
    return `[web:${index + 1}] ${result.title}\nurl: ${result.url}${source}${retrievedAt}\nsnippet: ${result.snippet}`
  }).join("\n\n")
}

function rankResources(resources: McpResource[], query: string | undefined) {
  if (!query?.trim()) return resources
  const terms = queryTerms(query)
  return resources.map((resource) => ({ resource, score: scoreText(`${resource.title} ${resource.description ?? ""} ${resource.text ?? ""}`, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.resource.title.localeCompare(b.resource.title))
    .map((item) => item.resource)
}

function rankWebResults(results: WebSearchResult[], query: string) {
  const terms = queryTerms(query)
  return results.map((result) => ({ result, score: scoreText(`${result.title} ${result.snippet} ${result.url}`, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .map((item) => item.result)
}

function selectEngine(engines: WebSearchEngine[], name: string | undefined) {
  if (!name) return undefined
  return engines.find((engine) => engine.name === name)
}

function withImplicitDefaults(config: z.infer<typeof WebSearchConfig>, env: Record<string, string | undefined>) {
  const tavilyConfigured = Boolean(env.TAVILY_API_KEY)
  const cx = env.GOOGLE_SEARCH_CX ?? env.GOOGLE_SEARCH_ENGINE_ID
  const existingGoogle = config.engines.find((engine) => engine.name === "google")
  const existingTavily = config.engines.find((engine) => engine.name === "tavily")
  const engines = config.engines.map((engine) => {
    if (engine.name !== "google" || "cx" in engine.extraParams || !cx) return engine
    return { ...engine, extraParams: { ...engine.extraParams, cx } }
  })
  if (!existingTavily && tavilyConfigured) {
    engines.push(WebSearchEngine.parse({
      name: "tavily",
      type: "tavily",
      apiKeyEnv: "TAVILY_API_KEY",
    }))
  }
  if (!existingGoogle && (env.GOOGLE_SEARCH_API_KEY || cx)) {
    engines.push(WebSearchEngine.parse({
      name: "google",
      type: "google",
      apiKeyEnv: "GOOGLE_SEARCH_API_KEY",
      extraParams: cx ? { cx } : {},
    }))
  }
  return {
    ...config,
    defaultEngine: config.defaultEngine ?? (
      engines.some((engine) => engine.name === "tavily") ? "tavily" :
      engines.some((engine) => engine.name === "google") ? "google" :
      undefined
    ),
    engines,
  }
}

function normalizeEngine(engine: WebSearchEngine): Required<Pick<WebSearchEngine, "name" | "type" | "method" | "endpoint" | "queryParam" | "limitParam" | "resultsPath" | "titlePath" | "urlPath" | "snippetPath">> & WebSearchEngine {
  if (engine.type === "brave") {
    return {
      ...engine,
      endpoint: engine.endpoint ?? "https://api.search.brave.com/res/v1/web/search",
      method: engine.method ?? "GET",
      queryParam: engine.queryParam ?? "q",
      limitParam: engine.limitParam ?? "count",
      resultsPath: engine.resultsPath ?? "web.results",
      titlePath: engine.titlePath ?? "title",
      urlPath: engine.urlPath ?? "url",
      snippetPath: engine.snippetPath ?? "description",
    }
  }
  if (engine.type === "google") {
    if (!("cx" in engine.extraParams)) {
      throw new Error(`google web search engine ${engine.name} requires extraParams.cx or GOOGLE_SEARCH_CX / GOOGLE_SEARCH_ENGINE_ID. ${webSearchEnvHint}`)
    }
    return {
      ...engine,
      endpoint: engine.endpoint ?? "https://customsearch.googleapis.com/customsearch/v1",
      method: engine.method ?? "GET",
      apiKeyParam: engine.apiKeyParam ?? "key",
      queryParam: engine.queryParam ?? "q",
      limitParam: engine.limitParam ?? "num",
      resultsPath: engine.resultsPath ?? "items",
      titlePath: engine.titlePath ?? "title",
      urlPath: engine.urlPath ?? "link",
      snippetPath: engine.snippetPath ?? "snippet",
    }
  }
  if (engine.type === "tavily") {
    return {
      ...engine,
      endpoint: engine.endpoint ?? "https://api.tavily.com/search",
      method: engine.method ?? "POST",
      queryParam: engine.queryParam ?? "query",
      limitParam: engine.limitParam ?? "max_results",
      resultsPath: engine.resultsPath ?? "results",
      titlePath: engine.titlePath ?? "title",
      urlPath: engine.urlPath ?? "url",
      snippetPath: engine.snippetPath ?? "content",
    }
  }
  if (!engine.endpoint) throw new Error(`custom web search engine ${engine.name} requires endpoint`)
  return {
    ...engine,
    endpoint: engine.endpoint,
    method: engine.method ?? "GET",
    queryParam: engine.queryParam ?? "q",
    limitParam: engine.limitParam ?? "limit",
    resultsPath: engine.resultsPath ?? "results",
    titlePath: engine.titlePath ?? "title",
    urlPath: engine.urlPath ?? "url",
    snippetPath: engine.snippetPath ?? "snippet",
  }
}

function apiKeyFor(engine: WebSearchEngine, env: Record<string, string | undefined>) {
  if (engine.apiKey) return engine.apiKey
  if (!engine.apiKeyEnv) return undefined
  const value = env[engine.apiKeyEnv]
  if (!value) throw new Error(`web search engine ${engine.name} requires ${engine.apiKeyEnv}. ${webSearchEnvHint}`)
  return value
}

function headersFor(engine: WebSearchEngine, apiKey: string | undefined) {
  const headers: Record<string, string> = { Accept: "application/json", ...engine.headers }
  if (!apiKey) return substituteHeaderTokens(headers, "")
  const headerName = engine.apiKeyHeader ?? (engine.type === "brave" ? "X-Subscription-Token" : engine.type === "tavily" ? "Authorization" : undefined)
  if (headerName) headers[headerName] = `${engine.apiKeyPrefix ?? (engine.type === "tavily" ? "Bearer " : "")}${apiKey}`
  return substituteHeaderTokens(headers, apiKey)
}

function substituteHeaderTokens(headers: Record<string, string>, apiKey: string) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, value.replaceAll("${API_KEY}", apiKey)]))
}

function requestFor(engine: ReturnType<typeof normalizeEngine>, query: string, limit: number, headers: Record<string, string>, apiKey: string | undefined, signal: AbortSignal | undefined) {
  const params = { ...engine.extraParams, [engine.queryParam]: query, [engine.limitParam]: limit }
  if (engine.apiKeyParam && apiKey) params[engine.apiKeyParam] = apiKey
  const timeout = timeoutSignal(signal, engine.timeoutMs)
  if (engine.method === "POST") {
    return {
      url: engine.endpoint,
      init: { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(params), signal: timeout.signal },
      cleanup: timeout.cleanup,
    }
  }
  const url = new URL(engine.endpoint)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  return { url, init: { method: "GET", headers, signal: timeout.signal }, cleanup: timeout.cleanup }
}

function parseEngineResults(payload: unknown, engine: ReturnType<typeof normalizeEngine>) {
  const rawResults = readPath(payload, engine.resultsPath)
  if (!Array.isArray(rawResults)) return [] as WebSearchResult[]
  const retrievedAt = new Date().toISOString()
  return rawResults.flatMap((item) => {
    const title = stringAt(item, engine.titlePath)
    const url = stringAt(item, engine.urlPath)
    const snippet = stringAt(item, engine.snippetPath)
    if (!title || !url || !snippet) return []
    const source = engine.sourcePath ? stringAt(item, engine.sourcePath) : hostnameFor(url)
    return [{ title, url, snippet, source, retrievedAt }]
  })
}

function readPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined
    return (current as Record<string, unknown>)[segment]
  }, value)
}

function stringAt(value: unknown, dottedPath: string) {
  const found = readPath(value, dottedPath)
  return typeof found === "string" && found.trim() ? found : undefined
}

function hostnameFor(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
  if (!timeoutMs) return { signal, cleanup: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  const cleanup = () => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
  signal?.addEventListener("abort", abort, { once: true })
  controller.signal.addEventListener("abort", cleanup, { once: true })
  return { signal: controller.signal, cleanup }
}

function queryTerms(query: string) {
  return query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5_.-]+/).filter(Boolean)
}

function scoreText(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0)
}

function clampLimit(limit: number) {
  if (!Number.isFinite(limit)) return 5
  return Math.max(1, Math.min(20, Math.round(limit)))
}
