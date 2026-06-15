import type { CitedSource, McpResource, WebFetchResult, WebSearchResult } from "./index"

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

export function webFetchCitation(result: WebFetchResult): CitedSource {
  return {
    type: "web",
    id: result.finalUrl,
    title: result.title,
    url: result.finalUrl,
    retrievedAt: result.retrievedAt,
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

export function formatWebFetchResult(result: WebFetchResult) {
  const lines = [
    `[web_fetch] ${result.method} ${result.url}`,
    `finalUrl: ${result.finalUrl}`,
    `status: ${result.status}${result.statusText ? ` ${result.statusText}` : ""}`,
  ]
  if (result.contentType) lines.push(`contentType: ${result.contentType}`)
  if (result.contentLength !== undefined) lines.push(`contentLength: ${result.contentLength}`)
  lines.push(`retrievedAt: ${result.retrievedAt}`)
  const headers = Object.entries(result.headers)
  if (headers.length > 0) {
    lines.push("headers:")
    for (const [name, value] of headers) lines.push(`${name}: ${value}`)
  }
  lines.push("body:")
  lines.push(result.excerpt || "(no body)")
  if (result.truncated) lines.push("[web_fetch] body truncated to maxBytes")
  return lines.join("\n")
}

export function rankResources(resources: McpResource[], query: string | undefined) {
  if (!query?.trim()) return resources
  const terms = queryTerms(query)
  return resources.map((resource) => ({ resource, score: scoreText(`${resource.title} ${resource.description ?? ""} ${resource.text ?? ""}`, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.resource.title.localeCompare(b.resource.title))
    .map((item) => item.resource)
}

export function rankWebResults(results: WebSearchResult[], query: string) {
  const terms = queryTerms(query)
  return results.map((result) => ({ result, score: scoreText(`${result.title} ${result.snippet} ${result.url}`, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .map((item) => item.result)
}

export function clampLimit(limit: number) {
  if (!Number.isFinite(limit)) return 5
  return Math.max(1, Math.min(20, Math.round(limit)))
}

function queryTerms(query: string) {
  return query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5_.-]+/).filter(Boolean)
}

function scoreText(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0)
}
