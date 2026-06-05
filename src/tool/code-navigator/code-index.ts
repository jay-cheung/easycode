import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { Sandbox } from "../../sandbox"
import { codeIndexCachePath, codeIndexGeneratorVersion } from "./constants"
import { easycodeDir } from "../../easycode-path"
import { cleanSignature, hashText, normalizeSymbolKind } from "./repo-map"
import { maskSearchableLines, uniqueSortedResults } from "./parsing"
import type { CallGraphDirection, CallGraphResult, CodeIndexEdge, CodeIndexFile, CodeIndexResult, CodeIndexSymbol, CodeSearchResult, RepoMapEntry } from "./types"
import { extractLocalBindingScopes, isTypeScriptLike, type LocalBindingScope } from "./ast"

type FileFingerprint = { filePath: string; mtimeMs: number; size: number }

const declarationPattern = /^\s*(?:export\s+)?(?:default\s+)?(async\s+function|function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b(.*)$/
const methodPattern = /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^ {]+)?\s*\{?\s*$/
const importPattern = /^\s*import\b.*?\bfrom\s+["']([^"']+)["']/
const sideEffectImportPattern = /^\s*import\s+["']([^"']+)["']/
const reExportPattern = /^\s*export\b.*?\bfrom\s+["']([^"']+)["']/
const exportListPattern = /^\s*export\s+\{([^}]+)\}/
const pythonDeclarationPattern = /^\s*(class|def|async\s+def)\s+([A-Za-z_][\w]*)\b/
const pythonImportPattern = /^\s*(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+(.+))/
const goDeclarationPattern = /^\s*(func|type|var|const)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\b/
const rustDeclarationPattern = /^\s*(?:pub\s+)?(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+([A-Za-z_]\w*)\b/
const javaLikeTypeDeclarationPattern = /^\s*(?:(?:public|private|protected|static|final|abstract|open|override|internal|data|sealed)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)\b/
const javaLikeFunctionDeclarationPattern = /^\s*(?:(?:public|private|protected|static|final|abstract|open|override|internal|suspend)\s+)*(fun|func)\s+([A-Za-z_]\w*)\s*\(/
const javaLikeMethodDeclarationPattern = /^\s*(?!return\b)(?:(?:public|private|protected|static|final|abstract|open|override|internal|synchronized|native|async)\s+)*(?:<[^>]+>\s*)?(?:[A-Za-z_$][\w$<>,.[\]?]*|void)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:[{;]|$)/
const cLikeDeclarationPattern = /^\s*(?:[A-Za-z_][\w:*<>,\s]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/
const goImportPattern = /^\s*import\s+(?:\(\s*)?["']([^"']+)["']/
const rustUsePattern = /^\s*use\s+(.+);/
const javaImportPattern = /^\s*import\s+(?:static\s+)?([\w.]+);/
const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g
const identifierPattern = /\b[A-Za-z_$][\w$]*\b/g
const classExtendsPattern = /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/
const implementsPattern = /\bclass\s+([A-Za-z_$][\w$]*)\b[^{]*\bimplements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/
const excludedMethods = new Set(["if", "for", "while", "switch", "catch", "function"])
const excludedCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "new", "typeof", "await"])
const excludedReferences = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
  "of", "override", "private", "protected", "public", "readonly", "return", "static", "super", "switch", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "var", "void", "while", "with", "yield",
])

export async function codeIndex(input: {
  sandbox: Sandbox
  dir: string
  files: FileFingerprint[]
  toolVersions: Record<string, string>
  useCache?: boolean
  gitIgnored: boolean
}) {
  const cachePath = path.join(easycodeDir(input.sandbox.root), "cache", "code-index", "index.json")
  const cached = input.useCache === false ? undefined : await readCachedCodeIndex(cachePath)
  if (input.useCache !== false) {
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

  const canIncremental = cached && codeIndexCacheCompatible(cached, {
    root: input.sandbox.root,
    dir: input.dir,
    generatorVersion: codeIndexGeneratorVersion,
    toolVersions: input.toolVersions,
  })
  const changedFiles = canIncremental ? changedFingerprints(cached, input.files) : input.files
  const changedPaths = new Set(changedFiles.map((file) => file.filePath))
  const currentPaths = new Set(input.files.map((file) => file.filePath))
  const indexedFiles: CodeIndexFile[] = canIncremental ? cached.files.filter((file) => currentPaths.has(file.filePath) && !changedPaths.has(file.filePath)) : []
  const symbols: CodeIndexSymbol[] = canIncremental ? cached.symbols.filter((symbol) => currentPaths.has(symbol.filePath) && !changedPaths.has(symbol.filePath)) : []
  const edges: CodeIndexEdge[] = canIncremental ? cached.edges.filter((edge) => currentPaths.has(edge.filePath) && !changedPaths.has(edge.filePath)) : []

  for (const file of changedFiles) {
    const text = await Bun.file(input.sandbox.resolve(file.filePath)).text().catch(() => "")
    const extracted = extractCodeIndex(text, file)
    indexedFiles.push(extracted.file)
    symbols.push(...extracted.symbols)
    edges.push(...extracted.edges)
  }

  const resolvedEdges = resolveEdges(symbols, indexedFiles, edges)
  const result: CodeIndexResult = {
    root: input.sandbox.root,
    dir: input.dir,
    generatedAt: new Date().toISOString(),
    generatorVersion: codeIndexGeneratorVersion,
    toolVersions: input.toolVersions,
    files: indexedFiles,
    symbols,
    edges: resolvedEdges,
    cache: { path: codeIndexCachePath, hit: false, gitIgnored: input.gitIgnored, rebuiltFiles: changedFiles.length },
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
  if (!codeIndexCacheCompatible(cached, expected)) return false
  if (cached.files.length !== expected.files.length) return false
  const files = new Map(cached.files.map((file) => [file.filePath, file]))
  return expected.files.every((file) => {
    const cachedFile = files.get(file.filePath)
    return cachedFile && cachedFile.mtimeMs === file.mtimeMs && cachedFile.size === file.size
  })
}

function codeIndexCacheCompatible(cached: CodeIndexResult, expected: { root: string; dir: string; generatorVersion: string; toolVersions: Record<string, string> }) {
  if (cached.root !== expected.root || cached.dir !== expected.dir || cached.generatorVersion !== expected.generatorVersion) return false
  return JSON.stringify(cached.toolVersions) === JSON.stringify(expected.toolVersions)
}

function changedFingerprints(cached: CodeIndexResult, files: FileFingerprint[]) {
  const previous = new Map(cached.files.map((file) => [file.filePath, file]))
  return files.filter((file) => {
    const cachedFile = previous.get(file.filePath)
    return !cachedFile || cachedFile.mtimeMs !== file.mtimeMs || cachedFile.size !== file.size
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
    imports: file.imports,
    exports: file.exports,
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
    .filter((edge) => (edge.to === symbol || edge.toName === symbol || symbolFromID(edge.toID)?.name === symbol) && (edge.kind === "calls" || edge.kind === "references"))
    .map((edge) => ({ filePath: edge.filePath, line: edge.line, preview: edge.preview ?? edge.to })))
    .slice(0, maxResults)
}

export function callGraphInCodeIndex(index: CodeIndexResult, input: { symbol: string; direction: CallGraphDirection; depth: number; maxResults: number }): CallGraphResult {
  const starts = index.symbols.filter((symbol) => symbol.name === input.symbol || symbol.qualifiedName === input.symbol || symbol.id === input.symbol)
  const symbolByID = new Map(index.symbols.map((symbol) => [symbol.id, symbol]))
  const callEdges = index.edges.filter((edge) => edge.kind === "calls" && edge.resolved && symbolByID.has(edge.from) && edge.toID && symbolByID.has(edge.toID))
  const forward = new Map<string, CodeIndexEdge[]>()
  const backward = new Map<string, CodeIndexEdge[]>()
  for (const edge of callEdges) {
    const to = edge.toID
    if (!to) continue
    forward.set(edge.from, [...(forward.get(edge.from) ?? []), edge])
    backward.set(to, [...(backward.get(to) ?? []), edge])
  }
  const nodeIDs = new Set(starts.map((symbol) => symbol.id))
  const resultEdges: CodeIndexEdge[] = []
  const queue = starts.map((symbol) => ({ id: symbol.id, depth: 0 }))
  const seen = new Set(queue.map((item) => `${item.id}:0`))
  while (queue.length > 0 && resultEdges.length < input.maxResults) {
    const current = queue.shift()
    if (!current || current.depth >= input.depth) continue
    const nextEdges = [
      ...(input.direction === "callees" || input.direction === "both" ? forward.get(current.id) ?? [] : []),
      ...(input.direction === "callers" || input.direction === "both" ? backward.get(current.id) ?? [] : []),
    ]
    for (const edge of nextEdges) {
      const nextID = edge.from === current.id ? edge.toID : edge.from
      if (!nextID) continue
      nodeIDs.add(edge.from)
      if (edge.toID) nodeIDs.add(edge.toID)
      resultEdges.push(edge)
      const key = `${nextID}:${current.depth + 1}`
      if (!seen.has(key)) {
        seen.add(key)
        queue.push({ id: nextID, depth: current.depth + 1 })
      }
      if (resultEdges.length >= input.maxResults) break
    }
  }
  return {
    symbol: input.symbol,
    direction: input.direction,
    depth: input.depth,
    nodes: [...nodeIDs].flatMap((id) => {
      const symbol = symbolByID.get(id)
      return symbol ? [{ id, name: symbol.name, filePath: symbol.filePath, line: symbol.startLine, signature: symbol.signature }] : []
    }).sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line || left.name.localeCompare(right.name)),
    edges: resultEdges.map((edge) => ({ from: edge.from, to: edge.toID ?? edge.to, filePath: edge.filePath, line: edge.line, preview: edge.preview })),
  }
}

function resolveEdges(symbols: CodeIndexSymbol[], files: CodeIndexFile[], edges: CodeIndexEdge[]) {
  const byID = new Map(symbols.map((symbol) => [symbol.id, symbol]))
  const byName = new Map<string, CodeIndexSymbol[]>()
  const byFile = new Map<string, CodeIndexSymbol[]>()
  const filesByPath = new Map(files.map((file) => [file.filePath, file]))
  for (const symbol of symbols) {
    byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol])
    byFile.set(symbol.filePath, [...(byFile.get(symbol.filePath) ?? []), symbol])
  }
  return edges.map((edge) => {
    const name = edge.toName ?? edge.to
    const local = (byFile.get(edge.filePath) ?? []).find((symbol) => symbol.name === name)
    const imported = resolveImportedSymbol(name, edge.receiverName, edge.filePath, filesByPath, byFile)
    const global = byName.get(name)?.length === 1 ? byName.get(name)?.[0] : undefined
    const target = imported ?? local ?? global
    const fromSymbol = byID.get(edge.from)
    return {
      ...edge,
      fromName: fromSymbol?.name,
      toID: target?.id,
      resolved: Boolean(target),
    }
  }).filter((edge) => edge.kind !== "references" || edge.resolved)
}

function resolveImportedSymbol(name: string, receiverName: string | undefined, filePath: string, filesByPath: Map<string, CodeIndexFile>, byFile: Map<string, CodeIndexSymbol[]>) {
  const file = filesByPath.get(filePath)
  const binding = file?.importBindings?.find((item) => item.local === (receiverName ?? name))
  if (!binding) return undefined
  const targetFile = resolveImportSource(filePath, binding.source, filesByPath)
  if (!targetFile) return undefined
  const importedName = binding.imported === "*" ? name : binding.imported
  return resolveExportedSymbol(targetFile.filePath, importedName, filesByPath, byFile, new Set())
}

function resolveExportedSymbol(filePath: string, exportedName: string, filesByPath: Map<string, CodeIndexFile>, byFile: Map<string, CodeIndexSymbol[]>, visited: Set<string>): CodeIndexSymbol | undefined {
  const visitKey = `${filePath}:${exportedName}`
  if (visited.has(visitKey)) return undefined
  visited.add(visitKey)

  const targetSymbols = byFile.get(filePath) ?? []
  if (exportedName === "default") return targetSymbols.find((symbol) => symbol.exportStyle === "default")

  const direct = targetSymbols.find((symbol) => symbol.name === exportedName)
  if (direct) return direct

  const file = filesByPath.get(filePath)
  const binding = file?.exportBindings?.find((item) => item.exported === exportedName)
  if (binding) {
    if (!binding.source) return targetSymbols.find((symbol) => symbol.name === binding.local)
    const sourceFile = resolveImportSource(filePath, binding.source, filesByPath)
    if (!sourceFile) return undefined
    return resolveExportedSymbol(sourceFile.filePath, binding.local, filesByPath, byFile, visited)
  }

  for (const source of file?.exportAllSources ?? []) {
    const sourceFile = resolveImportSource(filePath, source, filesByPath)
    if (!sourceFile) continue
    const resolved = resolveExportedSymbol(sourceFile.filePath, exportedName, filesByPath, byFile, visited)
    if (resolved) return resolved
  }
  return undefined
}

function resolveImportSource(fromFile: string, source: string, filesByPath: Map<string, CodeIndexFile>) {
  if (!source.startsWith(".")) return undefined
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), source))
  const candidates = [base, ...[...filesByPath.keys()].filter((filePath) => filePath.replace(/\.[^.]+$/, "") === base || filePath === `${base}/index.ts` || filePath === `${base}/index.js`)]
  for (const candidate of candidates) {
    const match = filesByPath.get(candidate)
    if (match) return match
  }
  return undefined
}

function symbolFromID(id: string | undefined) {
  if (!id) return undefined
  const hash = id.lastIndexOf("#")
  if (hash === -1) return undefined
  return { filePath: id.slice(0, hash), name: id.slice(hash + 1) }
}

function extractCodeIndex(text: string, file: FileFingerprint) {
  const lines = text.split(/\r?\n/)
  const searchableLines = maskSearchableLines(text)
  const declarations: CodeIndexSymbol[] = []
  const imports = new Set<string>()
  const exports = new Set<string>()
  const importBindings: CodeIndexFile["importBindings"] = []
  const exportBindings: CodeIndexFile["exportBindings"] = []
  const exportAllSources: NonNullable<CodeIndexFile["exportAllSources"]> = []
  const edges: CodeIndexEdge[] = []

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const declaration = matchDeclaration(line, file.filePath)
    if (declaration) {
      declarations.push(symbolFor(file.filePath, declaration.name, declaration.kind, lineNumber, line, {
        exported: declaration.exported,
        exportStyle: declaration.exportStyle,
      }))
      if (declaration.exported) exports.add(declaration.name)
      const extendsMatch = line.match(classExtendsPattern)
      if (extendsMatch) edges.push(rawEdge("inherits", symbolID(file.filePath, extendsMatch[1] ?? ""), extendsMatch[2] ?? "", file.filePath, lineNumber, line))
      const implementsMatch = line.match(implementsPattern)
      if (implementsMatch) {
        for (const implemented of (implementsMatch[2] ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
          edges.push(rawEdge("implements", symbolID(file.filePath, implementsMatch[1] ?? ""), implemented, file.filePath, lineNumber, line))
        }
      }
      continue
    }

    const method = isTypeScriptLike(path.extname(file.filePath)) ? line.match(methodPattern) : undefined
    if (method && !excludedMethods.has(method[1] ?? "")) {
      declarations.push(symbolFor(file.filePath, method[1] ?? "", "method", lineNumber, line))
    }

    const parsedImport = parseImportLine(line)
    if (parsedImport) {
      imports.add(parsedImport.source)
      importBindings.push(...parsedImport.bindings)
      edges.push(rawEdge("imports", `file:${file.filePath}`, parsedImport.source, file.filePath, lineNumber, line))
      continue
    }
    const parsedExportBindings = parseExportBindings(line)
    if (parsedExportBindings) {
      exportBindings.push(...parsedExportBindings.bindings)
      for (const binding of parsedExportBindings.bindings) exports.add(binding.exported)
      if (parsedExportBindings.source) edges.push(rawEdge("exports", `file:${file.filePath}`, parsedExportBindings.source, file.filePath, lineNumber, line))
      continue
    }
    const exportAllMatch = line.match(/^\s*export\s+\*\s+from\s+["']([^"']+)["']/)
    if (exportAllMatch?.[1]) {
      exportAllSources.push(exportAllMatch[1])
      edges.push(rawEdge("exports", `file:${file.filePath}`, exportAllMatch[1], file.filePath, lineNumber, line))
      continue
    }
    const reExportMatch = line.match(reExportPattern)
    if (reExportMatch?.[1]) edges.push(rawEdge("exports", `file:${file.filePath}`, reExportMatch[1], file.filePath, lineNumber, line))
    const exportList = line.match(exportListPattern)
    if (exportList?.[1]) {
      for (const item of exportList[1].split(",").map((part) => part.trim().split(/\s+as\s+/i)[0]?.trim()).filter(Boolean)) exports.add(item)
    }
  }

  const symbols = withEndLines(declarations, lines.length)
  const localBindingScopes = extractLocalBindingScopes(text, file.filePath, symbols)
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1
    if (parseImportLine(rawLine)) continue
    const line = searchableLines[index] ?? ""
    callPattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = callPattern.exec(line)) !== null) {
      const name = match[1] ?? ""
      if (excludedCalls.has(name)) continue
      if (symbols.some((symbol) => symbol.startLine === lineNumber && symbol.name === name)) continue
      const owner = symbolAtLine(symbols, lineNumber)
      if (owner && isLocalBindingReference(localBindingScopes, owner.id, name, lineNumber)) continue
      edges.push(rawEdge("calls", owner?.id ?? `file:${file.filePath}`, name, file.filePath, lineNumber, rawLine, propertyReceiver(line, match.index)))
    }
    identifierPattern.lastIndex = 0
    while ((match = identifierPattern.exec(line)) !== null) {
      const name = match[0] ?? ""
      if (excludedReferences.has(name)) continue
      if (symbols.some((symbol) => symbol.startLine === lineNumber && symbol.name === name)) continue
      if (isPropertyAccess(line, match.index)) continue
      const owner = symbolAtLine(symbols, lineNumber)
      if (owner && isLocalBindingReference(localBindingScopes, owner.id, name, lineNumber)) continue
      edges.push(rawEdge("references", owner?.id ?? `file:${file.filePath}`, name, file.filePath, lineNumber, rawLine))
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
      importBindings,
      exportBindings,
      exportAllSources,
    },
    symbols,
    edges,
  }
}

function matchDeclaration(line: string, filePath: string) {
  const extension = path.extname(filePath)
  if (isTypeScriptLike(extension)) {
    const ts = line.match(declarationPattern)
    if (!ts) return undefined
    if (/^\s+/.test(line) && !/^\s*export\b/.test(line)) return undefined
    const exported = /^\s*export\b/.test(line)
    const exportStyle: CodeIndexSymbol["exportStyle"] = /^\s*export\s+default\b/.test(line) ? "default" : exported ? "named" : undefined
    return {
      kind: normalizeSymbolKind(ts[1] ?? ""),
      name: ts[2] ?? "",
      exported,
      exportStyle,
    }
  }
  if (extension === ".py") {
    const py = line.match(pythonDeclarationPattern)
    if (py) return { kind: normalizeSymbolKind(py[1] ?? ""), name: py[2] ?? "", exported: true, exportStyle: "named" as const }
  }
  if (extension === ".go") {
    const go = line.match(goDeclarationPattern)
    if (go) {
      const exported = /^[A-Z]/.test(go[2] ?? "")
      return { kind: normalizeSymbolKind(go[1] ?? ""), name: go[2] ?? "", exported, exportStyle: exported ? "named" as const : undefined }
    }
  }
  if (extension === ".rs") {
    const rust = line.match(rustDeclarationPattern)
    if (rust) {
      const exported = /^\s*pub\b/.test(line)
      return { kind: normalizeSymbolKind(rust[1] ?? ""), name: rust[2] ?? "", exported, exportStyle: exported ? "named" as const : undefined }
    }
  }
  if ([".java", ".kt", ".kts", ".swift", ".cs"].includes(extension)) {
    const type = line.match(javaLikeTypeDeclarationPattern)
    if (type) {
      const exported = /\b(public|open)\b/.test(line)
      return { kind: normalizeSymbolKind(type[1] ?? ""), name: type[2] ?? "", exported, exportStyle: exported ? "named" as const : undefined }
    }
    const functionLike = line.match(javaLikeFunctionDeclarationPattern)
    if (functionLike) {
      const exported = /\b(public|open)\b/.test(line)
      return { kind: "method", name: functionLike[2] ?? "", exported, exportStyle: exported ? "named" as const : undefined }
    }
    const method = line.match(javaLikeMethodDeclarationPattern)
    if (method) {
      const exported = /\b(public|open)\b/.test(line)
      return { kind: "method", name: method[1] ?? "", exported, exportStyle: exported ? "named" as const : undefined }
    }
  }
  if ([".c", ".h", ".cpp", ".cc", ".hpp", ".php", ".rb"].includes(extension)) {
    const cLike = line.match(cLikeDeclarationPattern)
    if (cLike) return { kind: "function", name: cLike[1] ?? "", exported: true, exportStyle: "named" as const }
  }
  return undefined
}

function isLocalBindingReference(scopes: LocalBindingScope[], ownerID: string, name: string, line: number) {
  return scopes.some((scope) => scope.ownerID === ownerID && scope.startLine <= line && line <= scope.endLine && scope.names.has(name))
}

function parseImportLine(line: string): { source: string; bindings: NonNullable<CodeIndexFile["importBindings"]> } | undefined {
  const ts = line.match(importPattern) ?? line.match(sideEffectImportPattern)
  if (ts?.[1]) return { source: ts[1], bindings: parseTypeScriptImportBindings(line, ts[1]) }
  const py = line.match(pythonImportPattern)
  if (py) {
    const source = py[1] ?? py[3]?.split(",")[0]?.trim().split(/\s+as\s+/i)[0] ?? ""
    const bindings = (py[2] ?? py[3] ?? "").split(",").map((item) => {
      const [imported, local] = item.trim().split(/\s+as\s+/i)
      return imported ? { local: local ?? imported.split(".").at(-1) ?? imported, imported: imported.split(".").at(-1) ?? imported, source } : undefined
    }).filter((item): item is { local: string; imported: string; source: string } => Boolean(item))
    return source ? { source, bindings } : undefined
  }
  const go = line.match(goImportPattern)
  if (go?.[1]) return { source: go[1], bindings: [] }
  const rust = line.match(rustUsePattern)
  if (rust?.[1]) return { source: rust[1], bindings: [] }
  const java = line.match(javaImportPattern)
  if (java?.[1]) return { source: java[1], bindings: [{ local: java[1].split(".").at(-1) ?? java[1], imported: java[1].split(".").at(-1) ?? java[1], source: java[1] }] }
  return undefined
}

function parseTypeScriptImportBindings(line: string, source: string): NonNullable<CodeIndexFile["importBindings"]> {
  const bindings: NonNullable<CodeIndexFile["importBindings"]> = []
  const named = line.match(/\{([^}]+)\}/)
  if (named?.[1]) {
    for (const item of named[1].split(",")) {
      const [imported, local] = item.trim().split(/\s+as\s+/i)
      if (imported) bindings.push({ local: local ?? imported, imported, source })
    }
  }
  const defaultImport = line.match(/^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|\bfrom\b)/)
  if (defaultImport?.[1]) bindings.push({ local: defaultImport[1], imported: "default", source })
  const namespace = line.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
  if (namespace?.[1]) bindings.push({ local: namespace[1], imported: "*", source })
  return bindings
}

function parseExportBindings(line: string): { source?: string; bindings: NonNullable<CodeIndexFile["exportBindings"]> } | undefined {
  const match = line.match(/^\s*export\s+\{([^}]+)\}\s*(?:from\s+["']([^"']+)["'])?/)
  if (!match?.[1]) return undefined
  const source = match[2] ?? undefined
  const bindings: NonNullable<CodeIndexFile["exportBindings"]> = []
  for (const item of match[1].split(",")) {
    const [local, exported] = item.trim().split(/\s+as\s+/i)
    if (!local) continue
    bindings.push({ local: local.trim(), exported: (exported ?? local).trim(), source })
  }
  return { source, bindings }
}

function rawEdge(kind: CodeIndexEdge["kind"], from: string, to: string, filePath: string, line: number, source: string, receiverName?: string): CodeIndexEdge {
  return { kind, from, to, toName: to, receiverName, filePath, line, preview: source.trimEnd(), resolved: false }
}

function isPropertyAccess(line: string, index: number) {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(line[cursor] ?? "")) cursor -= 1
  return line[cursor] === "."
}

function propertyReceiver(line: string, index: number) {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(line[cursor] ?? "")) cursor -= 1
  if (line[cursor] !== ".") return undefined
  cursor -= 1
  while (cursor >= 0 && /\s/.test(line[cursor] ?? "")) cursor -= 1
  let end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(line[cursor] ?? "")) cursor -= 1
  const start = cursor + 1
  const receiver = line.slice(start, end)
  return receiver || undefined
}

function symbolFor(filePath: string, name: string, kind: string, line: number, source: string, options: { exported?: boolean; exportStyle?: "named" | "default"; ownerID?: string } = {}): CodeIndexSymbol {
  return {
    id: symbolID(filePath, name),
    qualifiedName: `${filePath.replace(/\.[^.]+$/, "")}.${name}`,
    filePath,
    name,
    kind,
    startLine: line,
    endLine: line,
    signature: cleanSignature(source),
    exported: options.exported,
    exportStyle: options.exportStyle,
    ownerID: options.ownerID,
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
