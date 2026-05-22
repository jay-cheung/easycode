import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { Sandbox } from "../../sandbox"
import { codeIndexCachePath, codeIndexGeneratorVersion } from "./constants"
import { cleanSignature, hashText, normalizeSymbolKind } from "./repo-map"
import { uniqueSortedResults } from "./parsing"
import type { CodeIndexEdge, CodeIndexFile, CodeIndexResult, CodeIndexSymbol, CodeSearchResult, RepoMapEntry } from "./types"

type FileFingerprint = { filePath: string; mtimeMs: number; size: number }

const declarationPattern = /^\s*(?:export\s+)?(?:default\s+)?(async\s+function|function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b(.*)$/
const methodPattern = /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^ {]+)?\s*\{?\s*$/
const importPattern = /^\s*import\b.*?\bfrom\s+["']([^"']+)["']/
const sideEffectImportPattern = /^\s*import\s+["']([^"']+)["']/
const reExportPattern = /^\s*export\b.*?\bfrom\s+["']([^"']+)["']/
const exportListPattern = /^\s*export\s+\{([^}]+)\}/
const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g
const classExtendsPattern = /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/
const implementsPattern = /\bclass\s+([A-Za-z_$][\w$]*)\b[^{]*\bimplements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/
const excludedMethods = new Set(["if", "for", "while", "switch", "catch", "function"])
const excludedCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "new", "typeof", "await"])

export async function codeIndex(input: {
  sandbox: Sandbox
  dir: string
  files: FileFingerprint[]
  toolVersions: Record<string, string>
  useCache?: boolean
  gitIgnored: boolean
}) {
  const cachePath = input.sandbox.resolve(codeIndexCachePath)
  if (input.useCache !== false) {
    const cached = await readCachedCodeIndex(cachePath)
    if (cached && codeIndexCacheValid(cached, {
      root: input.sandbox.root,
      dir: input.dir,
      generatorVersion: codeIndexGeneratorVersion,
      toolVersions: input.toolVersions,
      files: input.files,
    })) {
      return { ...cached, cache: { path: codeIndexCachePath, hit: true, gitIgnored: input.gitIgnored } }
    }
  }

  const indexedFiles: CodeIndexFile[] = []
  const symbols: CodeIndexSymbol[] = []
  const edges: CodeIndexEdge[] = []

  for (const file of input.files) {
    const text = await Bun.file(input.sandbox.resolve(file.filePath)).text().catch(() => "")
    const extracted = extractCodeIndex(text, file)
    indexedFiles.push(extracted.file)
    symbols.push(...extracted.symbols)
    edges.push(...extracted.edges)
  }

  const result: CodeIndexResult = {
    root: input.sandbox.root,
    dir: input.dir,
    generatedAt: new Date().toISOString(),
    generatorVersion: codeIndexGeneratorVersion,
    toolVersions: input.toolVersions,
    files: indexedFiles,
    symbols,
    edges,
    cache: { path: codeIndexCachePath, hit: false, gitIgnored: input.gitIgnored },
  }
  await mkdir(path.dirname(cachePath), { recursive: true })
  await Bun.write(cachePath, JSON.stringify(result, null, 2))
  return result
}

export async function readCachedCodeIndex(cachePath: string) {
  try {
    const parsed = JSON.parse(await Bun.file(cachePath).text()) as CodeIndexResult
    if (!Array.isArray(parsed.files) || !Array.isArray(parsed.symbols) || !Array.isArray(parsed.edges)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function codeIndexCacheValid(cached: CodeIndexResult, expected: { root: string; dir: string; generatorVersion: string; toolVersions: Record<string, string>; files: FileFingerprint[] }) {
  if (cached.root !== expected.root || cached.dir !== expected.dir || cached.generatorVersion !== expected.generatorVersion) return false
  if (JSON.stringify(cached.toolVersions) !== JSON.stringify(expected.toolVersions)) return false
  if (cached.files.length !== expected.files.length) return false
  const files = new Map(cached.files.map((file) => [file.filePath, file]))
  return expected.files.every((file) => {
    const cachedFile = files.get(file.filePath)
    return cachedFile && cachedFile.mtimeMs === file.mtimeMs && cachedFile.size === file.size
  })
}

export function repoMapEntriesFromCodeIndex(index: CodeIndexResult): RepoMapEntry[] {
  const symbolsByFile = new Map<string, CodeIndexSymbol[]>()
  for (const symbol of index.symbols) {
    const list = symbolsByFile.get(symbol.filePath) ?? []
    list.push(symbol)
    symbolsByFile.set(symbol.filePath, list)
  }
  return index.files.map((file) => ({
    filePath: file.filePath,
    hash: file.hash,
    mtimeMs: file.mtimeMs,
    size: file.size,
    symbols: (symbolsByFile.get(file.filePath) ?? []).map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.startLine,
      signature: symbol.signature,
    })),
  }))
}

export function findDefinitionsInCodeIndex(index: CodeIndexResult, symbol: string, maxResults: number) {
  return uniqueSortedResults(index.symbols
    .filter((item) => item.name === symbol)
    .map((item) => ({ filePath: item.filePath, line: item.startLine, preview: item.signature ?? item.name })))
    .slice(0, maxResults)
}

export function findReferencesInCodeIndex(index: CodeIndexResult, symbol: string, maxResults: number): CodeSearchResult[] {
  return uniqueSortedResults(index.edges
    .filter((edge) => edge.to === symbol && edge.kind === "calls")
    .map((edge) => ({ filePath: edge.filePath, line: edge.line, preview: edge.preview ?? edge.to })))
    .slice(0, maxResults)
}

function extractCodeIndex(text: string, file: FileFingerprint) {
  const lines = text.split(/\r?\n/)
  const declarations: CodeIndexSymbol[] = []
  const imports = new Set<string>()
  const exports = new Set<string>()
  const edges: CodeIndexEdge[] = []

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const declaration = line.match(declarationPattern)
    if (declaration) {
      const name = declaration[2] ?? ""
      const kind = normalizeSymbolKind(declaration[1] ?? "")
      declarations.push(symbolFor(file.filePath, name, kind, lineNumber, line))
      if (/^\s*export\b/.test(line)) exports.add(name)
      const extendsMatch = line.match(classExtendsPattern)
      if (extendsMatch) edges.push({ kind: "inherits", from: symbolID(file.filePath, extendsMatch[1] ?? ""), to: extendsMatch[2] ?? "", filePath: file.filePath, line: lineNumber, preview: line.trimEnd() })
      const implementsMatch = line.match(implementsPattern)
      if (implementsMatch) {
        for (const implemented of (implementsMatch[2] ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
          edges.push({ kind: "implements", from: symbolID(file.filePath, implementsMatch[1] ?? ""), to: implemented, filePath: file.filePath, line: lineNumber, preview: line.trimEnd() })
        }
      }
      continue
    }

    const method = line.match(methodPattern)
    if (method && !excludedMethods.has(method[1] ?? "")) {
      declarations.push(symbolFor(file.filePath, method[1] ?? "", "method", lineNumber, line))
    }

    const importMatch = line.match(importPattern) ?? line.match(sideEffectImportPattern)
    if (importMatch?.[1]) {
      imports.add(importMatch[1])
      edges.push({ kind: "imports", from: `file:${file.filePath}`, to: importMatch[1], filePath: file.filePath, line: lineNumber, preview: line.trimEnd() })
    }
    const reExportMatch = line.match(reExportPattern)
    if (reExportMatch?.[1]) edges.push({ kind: "exports", from: `file:${file.filePath}`, to: reExportMatch[1], filePath: file.filePath, line: lineNumber, preview: line.trimEnd() })
    const exportList = line.match(exportListPattern)
    if (exportList?.[1]) {
      for (const item of exportList[1].split(",").map((part) => part.trim().split(/\s+as\s+/i)[0]?.trim()).filter(Boolean)) exports.add(item)
    }
  }

  const symbols = withEndLines(declarations, lines.length)
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    callPattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = callPattern.exec(line)) !== null) {
      const name = match[1] ?? ""
      if (excludedCalls.has(name)) continue
      if (symbols.some((symbol) => symbol.startLine === lineNumber && symbol.name === name)) continue
      const owner = symbolAtLine(symbols, lineNumber)
      edges.push({ kind: "calls", from: owner?.id ?? `file:${file.filePath}`, to: name, filePath: file.filePath, line: lineNumber, preview: line.trimEnd() })
    }
  }

  return {
    file: {
      filePath: file.filePath,
      hash: hashText(text),
      mtimeMs: file.mtimeMs,
      size: file.size,
      imports: [...imports].sort(),
      exports: [...exports].sort(),
    },
    symbols,
    edges,
  }
}

function symbolFor(filePath: string, name: string, kind: string, line: number, source: string): CodeIndexSymbol {
  return {
    id: symbolID(filePath, name),
    filePath,
    name,
    kind,
    startLine: line,
    endLine: line,
    signature: cleanSignature(source),
  }
}

function withEndLines(symbols: CodeIndexSymbol[], fileLineCount: number) {
  const sorted = [...symbols].sort((left, right) => left.startLine - right.startLine || left.name.localeCompare(right.name))
  return sorted.map((symbol, index) => ({
    ...symbol,
    endLine: Math.max(symbol.startLine, (sorted[index + 1]?.startLine ?? fileLineCount + 1) - 1),
  }))
}

function symbolAtLine(symbols: CodeIndexSymbol[], line: number) {
  return symbols.find((symbol) => symbol.startLine <= line && line <= symbol.endLine)
}

function symbolID(filePath: string, name: string) {
  return `${filePath}#${name}`
}
