import path from "node:path"
import { z } from "zod"
import { easycodeDir } from "./easycode-path"

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

const WebSearchConfig = z.object({
  results: z.array(WebSearchResult).default([]),
})

export type McpResource = z.infer<typeof McpResource> & { server: string }
export type WebSearchResult = z.infer<typeof WebSearchResult>

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

  constructor(root: string) {
    this.configPath = path.join(easycodeDir(root), "websearch.json")
  }

  async search(query: string, limit = 5) {
    const file = Bun.file(this.configPath)
    if (!(await file.exists())) return [] as WebSearchResult[]
    const config = WebSearchConfig.parse(JSON.parse(await file.text()))
    return rankWebResults(config.results, query).slice(0, clampLimit(limit))
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
