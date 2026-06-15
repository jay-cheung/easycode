import path from "node:path"
import { z } from "zod"
import { easycodeDir } from "../easycode-path"
import { getTlsConfig } from "../tls-config"
import { clampLimit, formatMcpResource, formatMcpResources, formatWebFetchResult, formatWebResults, mcpCitation, rankResources, rankWebResults, webCitation, webFetchCitation } from "./retrieval-format"
import { apiKeyFor, headersFor, normalizeEngine, parseEngineResults, requestFor, timeoutSignal } from "./retrieval-live"
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

const WebFetchHeaderMap = z.record(z.string(), z.string())

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
export type WebFetchMethod = "GET" | "HEAD"

export type WebSearchResponse = {
  results: WebSearchResult[]
  live: boolean
  engine?: string
  warning?: string
}

export type WebFetchInput = {
  url: string
  method?: WebFetchMethod
  headers?: Record<string, string>
  followRedirects?: boolean
  includeHeaders?: boolean
  insecureTLS?: boolean
  timeoutMs?: number
  maxBytes?: number
  retries?: number
  retryDelayMs?: number
}

export type WebFetchResult = {
  url: string
  finalUrl: string
  method: WebFetchMethod
  status: number
  ok: boolean
  statusText: string
  redirected: boolean
  retrievedAt: string
  headers: Record<string, string>
  contentType?: string
  contentLength?: number
  title: string
  excerpt: string
  truncated: boolean
  bytesRead: number
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const safeWebFetchHeaderNames = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "range",
  "referer",
  "user-agent",
])

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

export class WebFetchService {
  constructor(
    private readonly options: { fetch?: FetchLike; env?: Record<string, string | undefined> } = {},
  ) {}

  async fetch(input: WebFetchInput, options: { signal?: AbortSignal } = {}): Promise<WebFetchResult> {
    const request = normalizeWebFetchInput(input)
    const fetcher = this.options.fetch ?? fetch
    const headers = sanitizeWebFetchHeaders(request.headers)
    const redirect = request.followRedirects ? "follow" : "manual"
    const timeout = timeoutSignal(options.signal, request.timeoutMs)
    const init: RequestInit & { tls?: unknown } = {
      method: request.method,
      headers,
      redirect,
      signal: timeout.signal,
    }
    const tlsConfig = request.insecureTLS ? { rejectUnauthorized: false } : getTlsConfig()
    if (tlsConfig && !this.options.fetch) init.tls = tlsConfig

    let lastError: unknown
    try {
      for (let attempt = 0; attempt <= request.retries; attempt += 1) {
        try {
          const response = await fetcher(request.url, init)
          const shouldRetry = attempt < request.retries && response.status >= 500
          if (shouldRetry) {
            await wait(request.retryDelayMs, timeout.signal)
            continue
          }
          return await readWebFetchResponse(response, request)
        } catch (error) {
          lastError = error
          if (attempt >= request.retries) break
          await wait(request.retryDelayMs, timeout.signal)
        }
      }
    } finally {
      timeout.cleanup()
    }
    if (lastError instanceof Error) throw lastError
    throw new Error(`web fetch failed for ${request.url}`)
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

function normalizeWebFetchInput(input: WebFetchInput) {
  const parsed = WebFetchHeaderMap.parse(input.headers ?? {})
  const url = parseWebFetchUrl(input.url)
  return {
    url: url.toString(),
    method: input.method === "HEAD" ? "HEAD" : "GET" as WebFetchMethod,
    headers: parsed,
    followRedirects: input.followRedirects === true,
    includeHeaders: input.includeHeaders === true,
    insecureTLS: input.insecureTLS === true,
    timeoutMs: clampWebFetchTimeout(input.timeoutMs),
    maxBytes: clampWebFetchBytes(input.maxBytes),
    retries: clampWebFetchRetries(input.retries),
    retryDelayMs: clampWebFetchRetryDelay(input.retryDelayMs),
  }
}

function parseWebFetchUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`web fetch url must be a valid absolute URL: ${value}`)
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`web fetch supports http/https only: ${value}`)
  return url
}

function sanitizeWebFetchHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers)
  const sanitized: Record<string, string> = {}
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase()
    const value = rawValue.trim()
    if (!name || !value) throw new Error("web fetch headers must use non-empty names and values")
    if (!safeWebFetchHeaderNames.has(name)) {
      throw new Error(`web fetch header not allowed: ${rawName}`)
    }
    sanitized[name] = value
  }
  return sanitized
}

async function readWebFetchResponse(response: Response, request: ReturnType<typeof normalizeWebFetchInput>): Promise<WebFetchResult> {
  const retrievedAt = new Date().toISOString()
  const contentType = response.headers.get("content-type") ?? undefined
  const contentLength = numericHeader(response.headers.get("content-length"))
  const headers = responseHeaderMap(response.headers, request.includeHeaders)
  const body = request.method === "HEAD" ? { bytes: new Uint8Array(), truncated: false } : await readResponseBytes(response, request.maxBytes)
  const excerpt = body.bytes.byteLength === 0
    ? ""
    : isTextualContentType(contentType)
      ? new TextDecoder().decode(body.bytes).trim()
      : `[binary response omitted: ${contentType ?? "unknown content-type"}]`
  return {
    url: request.url,
    finalUrl: response.url || request.url,
    method: request.method,
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    redirected: response.redirected,
    retrievedAt,
    headers,
    contentType,
    contentLength,
    title: inferWebFetchTitle(response.url || request.url, request.method, contentType, excerpt),
    excerpt,
    truncated: body.truncated,
    bytesRead: body.bytes.byteLength,
  }
}

async function readResponseBytes(response: Response, maxBytes: number) {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const remaining = maxBytes - total
      if (remaining <= 0) {
        truncated = true
        try { await reader.cancel() } catch {}
        break
      }
      if (value.byteLength <= remaining) {
        chunks.push(value)
        total += value.byteLength
        continue
      }
      chunks.push(value.slice(0, remaining))
      total += remaining
      truncated = true
      try { await reader.cancel() } catch {}
      break
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

function responseHeaderMap(headers: Headers, includeAll: boolean) {
  const preferred = includeAll
    ? [...headers.entries()]
    : [...headers.entries()].filter(([name]) => ["cache-control", "content-length", "content-type", "etag", "last-modified", "location"].includes(name.toLowerCase()))
  return Object.fromEntries(preferred)
}

function inferWebFetchTitle(url: string, method: WebFetchMethod, contentType: string | undefined, excerpt: string) {
  if (contentType?.toLowerCase().includes("text/html")) {
    const match = excerpt.match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i)
    if (match?.[1]?.trim()) return match[1].replace(/\s+/g, " ").trim()
  }
  try {
    const parsed = new URL(url)
    return `${method} ${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return `${method} ${url}`
  }
}

function numericHeader(value: string | null) {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isTextualContentType(contentType: string | undefined) {
  if (!contentType) return true
  const normalized = contentType.toLowerCase()
  return normalized.startsWith("text/")
    || normalized.includes("json")
    || normalized.includes("xml")
    || normalized.includes("javascript")
    || normalized.includes("x-www-form-urlencoded")
}

function clampWebFetchTimeout(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10_000
  return Math.max(1_000, Math.min(60_000, Math.round(value)))
}

function clampWebFetchBytes(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 24_000
  return Math.max(512, Math.min(64_000, Math.round(value)))
}

function clampWebFetchRetries(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(3, Math.round(value)))
}

function clampWebFetchRetryDelay(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 250
  return Math.max(0, Math.min(5_000, Math.round(value)))
}

async function wait(delayMs: number, signal: AbortSignal | undefined) {
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

export { clampLimit, formatMcpResource, formatMcpResources, formatWebFetchResult, formatWebResults, mcpCitation, webCitation, webFetchCitation }
