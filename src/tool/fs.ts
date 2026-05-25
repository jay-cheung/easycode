import path from "node:path"
import { z } from "zod"
import type { ToolContext } from "./registry"

export const maxFullReadLines = 100
export const ReadInput = z.object({ filePath: z.string() })
const OptionalString = z.string().nullish().transform((value) => value ?? undefined)
const OptionalBoolean = z.boolean().nullish().transform((value) => value ?? undefined)
const OptionalNumber = z.number().nullish().transform((value) => value ?? undefined)
export const ListInput = z.object({ dirPath: OptionalString })
export const GrepInput = z.object({ query: z.string(), dir: OptionalString })
export const RgSearchInput = z.object({ query: z.string(), dir: OptionalString, fileType: OptionalString, maxResults: OptionalNumber })
export const ReadLinesInput = z.object({ filePath: z.string(), startLine: z.number(), endLine: z.number() })
export const FindDefinitionInput = z.object({ symbol: z.string(), language: OptionalString, maxResults: OptionalNumber })
export const FindReferencesInput = z.object({ symbol: z.string(), language: OptionalString, maxResults: OptionalNumber })
export const CallGraphInput = z.object({ symbol: z.string(), direction: z.enum(["callers", "callees", "both"]).nullish().transform((value) => value ?? undefined), depth: OptionalNumber, language: OptionalString, maxResults: OptionalNumber })
export const RepoMapInput = z.object({ dir: OptionalString, language: OptionalString, maxFiles: OptionalNumber, useCache: OptionalBoolean, query: OptionalString })
export const WriteInput = z.object({ filePath: z.string(), content: z.string() })
export const EditInput = z.object({ filePath: z.string(), oldString: z.string(), newString: z.string(), replaceAll: OptionalBoolean })

export function relativePattern(ctx: ToolContext, filePath: string) {
  const resolved = path.resolve(ctx.sandbox.root, filePath)
  return ctx.sandbox.contains(resolved) ? path.relative(ctx.sandbox.root, resolved) || "." : resolved
}


export function formatSearchResults(results: Array<{ filePath: string; line: number; preview: string }>) {
  if (results.length === 0) return "No matches."
  return results.map((result) => `${result.filePath}:${result.line}: ${result.preview}`).join("\n")
}

export function formatRepoMap(map: { cache: { path: string; hit: boolean; gitIgnored: boolean }; entries: Array<{ filePath: string; symbols: Array<{ name: string; kind: string; line: number; signature?: string }> }> }) {
  const lines = [`cache=${map.cache.hit ? "hit" : "rebuilt"} path=${map.cache.path}`]
  if (!map.cache.gitIgnored) lines.push("warning: .easycode is not ignored by .gitignore; repo_map cache is a derived local artifact and should not be committed.")
  for (const entry of map.entries) {
    lines.push(`File: ${entry.filePath}`)
    if (entry.symbols.length === 0) {
      lines.push("  (no top-level symbols found)")
      continue
    }
    for (const symbol of entry.symbols) lines.push(`  ${symbol.kind} ${symbol.name} @ ${symbol.line}${symbol.signature ? ` :: ${symbol.signature}` : ""}`)
  }
  return lines.join("\n")
}

export function formatCallGraph(graph: { symbol: string; direction: string; depth: number; nodes: Array<{ id: string; name: string; filePath: string; line: number; signature?: string }>; edges: Array<{ from: string; to: string; filePath: string; line: number; preview?: string }> }) {
  if (graph.nodes.length === 0) return `No call graph nodes found for ${graph.symbol}.`
  const lines = [`call_graph symbol=${graph.symbol} direction=${graph.direction} depth=${graph.depth}`]
  lines.push("Nodes:")
  for (const node of graph.nodes) lines.push(`  ${node.id} @ ${node.filePath}:${node.line}${node.signature ? ` :: ${node.signature}` : ""}`)
  lines.push("Edges:")
  if (graph.edges.length === 0) lines.push("  (no resolved call edges)")
  for (const edge of graph.edges) lines.push(`  ${edge.from} -> ${edge.to} @ ${edge.filePath}:${edge.line}${edge.preview ? ` :: ${edge.preview}` : ""}`)
  return lines.join("\n")
}


export function countLines(text: string) {
  if (!text) return 0
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

