import type { WebSearchEngine, WebSearchResult } from "./retrieval"

export function normalizeEngine(engine: WebSearchEngine, tavilySetupHint: string): Required<Pick<WebSearchEngine, "name" | "type" | "method" | "endpoint" | "queryParam" | "limitParam" | "resultsPath" | "titlePath" | "urlPath" | "snippetPath">> & WebSearchEngine {
  if (engine.type !== "tavily") {
    throw new Error(`web search engine ${engine.name} type ${engine.type} is not supported; only tavily is available. ${tavilySetupHint}`)
  }
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

export function apiKeyFor(engine: WebSearchEngine, env: Record<string, string | undefined>, webSearchEnvHint: string) {
  if (engine.apiKey) return engine.apiKey
  if (!engine.apiKeyEnv) return undefined
  const value = env[engine.apiKeyEnv]
  if (!value) throw new Error(`web search engine ${engine.name} requires ${engine.apiKeyEnv}. ${webSearchEnvHint}`)
  return value
}

export function headersFor(engine: WebSearchEngine, apiKey: string | undefined) {
  const headers: Record<string, string> = { Accept: "application/json", ...engine.headers }
  if (!apiKey) return substituteHeaderTokens(headers, "")
  const headerName = engine.apiKeyHeader ?? "Authorization"
  if (headerName) headers[headerName] = `${engine.apiKeyPrefix ?? "Bearer "}${apiKey}`
  return substituteHeaderTokens(headers, apiKey)
}

export function requestFor(engine: ReturnType<typeof normalizeEngine>, query: string, limit: number, headers: Record<string, string>, signal: AbortSignal | undefined) {
  const params = { ...engine.extraParams, [engine.queryParam]: query, [engine.limitParam]: limit }
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

export function parseEngineResults(payload: unknown, engine: ReturnType<typeof normalizeEngine>) {
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

function substituteHeaderTokens(headers: Record<string, string>, apiKey: string) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, value.replaceAll("${API_KEY}", apiKey)]))
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
