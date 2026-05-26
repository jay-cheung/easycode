import path from "node:path"
import { createHash } from "node:crypto"
import type { RepoMapEntry, RepoMapResult } from "./types"

export function normalizeSymbolKind(kind: string) {
  return kind.replace(/^async\s+/, "")
}

export function cleanSignature(line: string) {
  return line.trim().replace(/\s*\{.*$/, "").replace(/\s+/g, " ")
}

export async function readCachedRepoMap(cachePath: string) {
  try {
    const parsed = JSON.parse(await Bun.file(cachePath).text()) as RepoMapResult
    if (!Array.isArray(parsed.entries)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export async function projectIgnoresEasyCode(root: string) {
  const text = await Bun.file(path.join(root, ".gitignore")).text().catch(() => "")
  return text.split(/\r?\n/).map((line) => line.trim()).some((line) => line === ".easycode" || line === ".easycode/" || line === "/.easycode" || line === "/.easycode/")
}

export function repoMapCacheValid(cached: RepoMapResult, expected: { root: string; dir: string; generatorVersion: string; toolVersions: Record<string, string>; files: Array<{ filePath: string; mtimeMs: number; size: number }> }) {
  if (cached.root !== expected.root || cached.dir !== expected.dir || cached.generatorVersion !== expected.generatorVersion) return false
  if (JSON.stringify(cached.toolVersions) !== JSON.stringify(expected.toolVersions)) return false
  if (cached.entries.length !== expected.files.length) return false
  const entries = new Map(cached.entries.map((entry) => [entry.filePath, entry]))
  return expected.files.every((file) => {
    const entry = entries.get(file.filePath)
    return entry && entry.mtimeMs === file.mtimeMs && entry.size === file.size
  })
}

export function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

export function scoreAndFilterRepoMap(map: RepoMapResult, query: string): RepoMapResult {
  const terms = query.toLowerCase().split(/[^a-z0-9_$]+/).filter(term => term.length >= 2)
  if (terms.length === 0) return map

  const scoredEntries: Array<{ entry: RepoMapEntry; score: number }> = []

  for (const entry of map.entries) {
    const fileLower = entry.filePath.toLowerCase()
    
    let pathScore = 0
    for (const term of terms) {
      if (fileLower.includes(term)) {
        const basename = fileLower.split("/").pop() ?? ""
        if (basename.includes(term)) {
          pathScore += 10
        } else {
          pathScore += 5
        }
      }
    }

    let symbolScore = 0
    const matchingSymbols = entry.symbols.filter(symbol => {
      const nameLower = symbol.name.toLowerCase()
      const signatureLower = (symbol.signature ?? "").toLowerCase()
      let matched = false
      for (const term of terms) {
        if (nameLower.includes(term)) {
          matched = true
          symbolScore += 5
          if (nameLower === term) {
            symbolScore += 10
          }
        }
        if (signatureLower.includes(term)) {
          matched = true
          symbolScore += 2
        }
      }
      return matched
    })

    let metadataScore = 0
    const metadata = [...(entry.imports ?? []), ...(entry.exports ?? [])].join(" ").toLowerCase()
    for (const term of terms) {
      if (metadata.includes(term)) metadataScore += 3
    }

    const totalScore = pathScore + symbolScore + metadataScore
    if (totalScore > 0) {
      const symbolsToKeep = matchingSymbols.length > 0 ? matchingSymbols : entry.symbols
      scoredEntries.push({
        entry: { ...entry, symbols: symbolsToKeep },
        score: totalScore
      })
    }
  }

  scoredEntries.sort((left, right) => right.score - left.score || left.entry.filePath.localeCompare(right.entry.filePath))

  const filteredEntries = scoredEntries.map(item => item.entry).slice(0, 15)

  return {
    ...map,
    entries: filteredEntries
  }
}
