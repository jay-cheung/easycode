import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import type { Sandbox } from "../sandbox"

const require = createRequire(import.meta.url)

export type CodeSearchResult = {
  filePath: string
  line: number
  preview: string
}

export type CodeRange = {
  filePath: string
  startLine: number
  endLine: number
}

export type RepoMapSymbol = {
  name: string
  kind: string
  line: number
  signature?: string
}

export type RepoMapEntry = {
  filePath: string
  hash: string
  mtimeMs: number
  size: number
  symbols: RepoMapSymbol[]
}

export type RepoMapResult = {
  root: string
  dir: string
  generatedAt: string
  generatorVersion: string
  toolVersions: Record<string, string>
  entries: RepoMapEntry[]
  cache: {
    path: string
    hit: boolean
    gitIgnored: boolean
  }
}

export interface CodeNavigator {
  rgSearch(input: { query: string; dir?: string; fileType?: string; maxResults?: number }): Promise<CodeSearchResult[]>
  readLines(input: { filePath: string; startLine: number; endLine: number }): Promise<CodeRange & { content: string }>
  findDefinition(input: { symbol: string; language?: string; maxResults?: number }): Promise<CodeSearchResult[]>
  findReferences(input: { symbol: string; language?: string; maxResults?: number }): Promise<CodeSearchResult[]>
  repoMap(input: { dir?: string; language?: string; maxFiles?: number; useCache?: boolean; query?: string }): Promise<RepoMapResult>
}

type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

type CommandRunner = (command: string, args: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<CommandResult>

const repoMapGeneratorVersion = "1"
const defaultMaxResults = 50
const maxMaxResults = 200
const defaultReadLineLimit = 200
const repoMapCachePath = path.join(".easycode", "cache", "repo-map.json")
const ignoredDirs = new Set([".git", "node_modules", ".easycode", "dist", "build", "coverage"])
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

export class CliCodeNavigator implements CodeNavigator {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly options: { runner?: CommandRunner; signal?: AbortSignal } = {},
  ) {}

  async rgSearch(input: { query: string; dir?: string; fileType?: string; maxResults?: number }) {
    const maxResults = normalizeMaxResults(input.maxResults)
    const dir = this.relativeDir(input.dir)
    
    try {
      const rgBinary = getRgPath()
      const args = ["--json", "--line-number", "--column", "--no-heading", "--color", "never", ...fileTypeArgs(input.fileType), input.query, dir]
      const result = await this.run(rgBinary, args)
      if (result.exitCode === 0 || result.exitCode === 1) {
        return parseRgJson(result.stdout).slice(0, maxResults)
      }
    } catch {
      // Fall through to pure JS fallback
    }

    return this.jsRgSearchFallback(input)
  }

  async readLines(input: { filePath: string; startLine: number; endLine: number }) {
    if (!Number.isInteger(input.startLine) || !Number.isInteger(input.endLine) || input.startLine < 1 || input.endLine < input.startLine) {
      throw new Error("read_lines requires 1-based startLine and endLine with startLine <= endLine")
    }
    if (input.endLine - input.startLine + 1 > defaultReadLineLimit) {
      throw new Error(`read_lines can read at most ${defaultReadLineLimit} lines; narrow the requested range`)
    }
    const text = await this.sandbox.readFile(input.filePath)
    const lines = text.split(/\r?\n/)
    if (input.startLine > lines.length) throw new Error(`startLine ${input.startLine} is past end of file ${input.filePath} (${lines.length} lines)`)
    const selected = lines.slice(input.startLine - 1, Math.min(input.endLine, lines.length))
    return {
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.startLine + selected.length - 1,
      content: selected.map((line, index) => `${input.startLine + index} | ${line}`).join("\n"),
    }
  }

  async findDefinition(input: { symbol: string; language?: string; maxResults?: number }) {
    const maxResults = normalizeMaxResults(input.maxResults)
    const language = input.language ?? "typescript"
    const patterns = definitionPatterns(input.symbol)
    const results: CodeSearchResult[] = []
    
    let astGrepMissing = false
    try {
      for (const pattern of patterns) {
        const result = await this.run("ast-grep", ["--json", "--lang", language, "--pattern", pattern, "."])
        if (result.exitCode === 0 || result.exitCode === 1) {
          results.push(...parseAstGrepJson(result.stdout))
        } else {
          astGrepMissing = true
          break
        }
        if (results.length >= maxResults) break
      }
      if (!astGrepMissing) {
        return uniqueSortedResults(results).slice(0, maxResults)
      }
    } catch {
      astGrepMissing = true
    }

    return this.jsFindDefinitionFallback(input)
  }

  async findReferences(input: { symbol: string; language?: string; maxResults?: number }) {
    const query = `\\b${escapeRegExp(input.symbol)}\\b`
    const fileType = languageToFileType(input.language)
    return this.rgSearch({ query, fileType, maxResults: input.maxResults })
  }

  async repoMap(input: { dir?: string; language?: string; maxFiles?: number; useCache?: boolean; query?: string }) {
    const dir = this.relativeDir(input.dir)
    const maxFiles = clampInt(input.maxFiles ?? 200, 1, 2_000)
    const cachePath = this.sandbox.resolve(repoMapCachePath)
    const cacheIgnored = await projectIgnoresEasyCode(this.sandbox.root)
    const toolVersions = await this.toolVersions()
    const fingerprint = await this.repoFingerprint({ dir, language: input.language, maxFiles })
    
    let result: RepoMapResult | undefined
    
    if (input.useCache !== false) {
      const cached = await readCachedRepoMap(cachePath)
      if (cached && repoMapCacheValid(cached, { root: this.sandbox.root, dir, generatorVersion: repoMapGeneratorVersion, toolVersions, files: fingerprint.files })) {
        result = { ...cached, cache: { path: repoMapCachePath, hit: true, gitIgnored: cacheIgnored } }
      }
    }

    if (!result) {
      const entries: RepoMapEntry[] = []
      for (const file of fingerprint.files) {
        const text = await Bun.file(this.sandbox.resolve(file.filePath)).text().catch(() => "")
        entries.push({
          filePath: file.filePath,
          hash: hashText(text),
          mtimeMs: file.mtimeMs,
          size: file.size,
          symbols: extractSymbols(text),
        })
      }
      result = {
        root: this.sandbox.root,
        dir,
        generatedAt: new Date().toISOString(),
        generatorVersion: repoMapGeneratorVersion,
        toolVersions,
        entries,
        cache: { path: repoMapCachePath, hit: false, gitIgnored: cacheIgnored },
      }
      await mkdir(path.dirname(cachePath), { recursive: true })
      await Bun.write(cachePath, JSON.stringify(result, null, 2))
    }

    if (input.query) {
      return scoreAndFilterRepoMap(result, input.query)
    }
    return result
  }

  private async repoFingerprint(input: { dir: string; language?: string; maxFiles: number }) {
    const root = this.sandbox.resolve(input.dir)
    const files: Array<{ filePath: string; mtimeMs: number; size: number }> = []
    const allowedExtensions = extensionsForLanguage(input.language)
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (files.length >= input.maxFiles) return
        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name)) await walk(path.join(dir, entry.name))
          continue
        }
        const full = path.join(dir, entry.name)
        const extension = path.extname(entry.name)
        if (!allowedExtensions.has(extension)) continue
        const relative = path.relative(this.sandbox.root, full).replaceAll(path.sep, "/")
        const info = await stat(full)
        files.push({ filePath: relative, mtimeMs: info.mtimeMs, size: info.size })
        if (files.length >= input.maxFiles) return
      }
    }
    await walk(root)
    files.sort((left, right) => left.filePath.localeCompare(right.filePath))
    return { files: files.slice(0, input.maxFiles) }
  }

  private relativeDir(dir = ".") {
    const resolved = this.sandbox.resolve(dir)
    return path.relative(this.sandbox.root, resolved).replaceAll(path.sep, "/") || "."
  }

  private async toolVersions() {
    const [rg, astGrep] = await Promise.all([this.optionalVersion("rg"), this.optionalVersion("ast-grep")])
    return { rg, "ast-grep": astGrep }
  }

  private async optionalVersion(command: string) {
    try {
      const result = await this.run(command, ["--version"])
      return firstLine(result.stdout || result.stderr) || "unknown"
    } catch {
      return "missing"
    }
  }

  private async runRequired(command: string, args: string[]) {
    try {
      return await this.run(command, args)
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found|No such file/i.test(error.message)) throw new Error(`${command} is required for this tool but was not found on PATH`)
      throw error
    }
  }

  private run(command: string, args: string[]) {
    const runner = this.options.runner ?? defaultRunner
    return runner(command, args, { cwd: this.sandbox.root, signal: this.options.signal })
  }

  private async jsRgSearchFallback(input: { query: string; dir?: string; fileType?: string; maxResults?: number }): Promise<CodeSearchResult[]> {
    const maxResults = normalizeMaxResults(input.maxResults)
    const relativeDir = this.relativeDir(input.dir)
    const root = this.sandbox.resolve(relativeDir)
    const allowedExtensions = extensionsForLanguage(input.fileType)
    const results: CodeSearchResult[] = []
    
    let queryRegex: RegExp
    try {
      queryRegex = new RegExp(input.query, "i")
    } catch {
      queryRegex = new RegExp(escapeRegExp(input.query), "i")
    }

    const walk = async (dir: string) => {
      let entries: any[] = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (results.length >= maxResults) return
        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name)) {
            await walk(path.join(dir, entry.name))
          }
          continue
        }
        
        const fullPath = path.join(dir, entry.name)
        const extension = path.extname(entry.name)
        if (input.fileType && !allowedExtensions.has(extension)) continue
        if (entry.name.endsWith(".json") || entry.name.endsWith(".map") || entry.name.endsWith(".png") || entry.name.endsWith(".jpg")) continue

        try {
          const text = await this.sandbox.readFile(path.relative(this.sandbox.root, fullPath))
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            if (queryRegex.test(lines[i])) {
              results.push({
                filePath: path.relative(this.sandbox.root, fullPath).replaceAll(path.sep, "/"),
                line: i + 1,
                preview: lines[i].trimEnd(),
              })
              if (results.length >= maxResults) return
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    await walk(root)
    return results
  }

  private async jsFindDefinitionFallback(input: { symbol: string; language?: string; maxResults?: number }): Promise<CodeSearchResult[]> {
    const maxResults = normalizeMaxResults(input.maxResults)
    const language = input.language ?? "typescript"
    const allowedExtensions = extensionsForLanguage(languageToFileType(language))
    const results: CodeSearchResult[] = []
    const escaped = escapeRegExp(input.symbol)

    const declRegex = new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b`
    )

    const methodRegex = new RegExp(
      `^\\s*(?:(?:public|private|protected|static|async|override|readonly)\\s+)*${escaped}\\s*\\(`
    )

    const root = this.sandbox.root
    const walk = async (dir: string) => {
      let entries: any[] = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (results.length >= maxResults) return
        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name)) {
            await walk(path.join(dir, entry.name))
          }
          continue
        }
        
        const fullPath = path.join(dir, entry.name)
        const extension = path.extname(entry.name)
        if (!allowedExtensions.has(extension)) continue

        try {
          const text = await this.sandbox.readFile(path.relative(this.sandbox.root, fullPath))
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (declRegex.test(line) || methodRegex.test(line)) {
              results.push({
                filePath: path.relative(this.sandbox.root, fullPath).replaceAll(path.sep, "/"),
                line: i + 1,
                preview: line.trimEnd(),
              })
              if (results.length >= maxResults) return
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    await walk(root)
    return uniqueSortedResults(results)
  }
}

let cachedRgPath: string | null = null
function getRgPath(): string {
  if (process.env.NODE_ENV === "test") return "rg"
  if (cachedRgPath) return cachedRgPath
  try {
    const proc = Bun.spawnSync(["which", "rg"])
    if (proc.success) {
      const p = proc.stdout.toString().trim()
      if (p && existsSync(p)) {
        cachedRgPath = p
        return p
      }
    }
  } catch {}

  const macOSPaths = [
    "/Applications/Codex.app/Contents/Resources/rg",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
    "/Applications/Cursor.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg"
  ]
  for (const p of macOSPaths) {
    if (existsSync(p)) {
      cachedRgPath = p
      return p
    }
  }

  try {
    const vscodeRg = require("vscode-ripgrep")
    if (vscodeRg && vscodeRg.rgPath && existsSync(vscodeRg.rgPath)) {
      cachedRgPath = vscodeRg.rgPath
      return vscodeRg.rgPath
    }
  } catch {}

  cachedRgPath = "rg"
  return "rg"
}

function defaultRunner(command: string, args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe", signal: options.signal })
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.catch(() => null),
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))
}

function normalizeMaxResults(value: number | undefined) {
  return clampInt(value ?? defaultMaxResults, 1, maxMaxResults)
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function fileTypeArgs(fileType: string | undefined) {
  if (!fileType) return []
  const normalized = fileType.replace(/^\./, "")
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) throw new Error("fileType must be a simple extension or rg type name")
  return ["--glob", `*.${normalized}`]
}

function parseRgJson(stdout: string) {
  const results: CodeSearchResult[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
    if (event.type !== "match" || !event.data?.path?.text || !event.data.line_number) continue
    results.push({
      filePath: normalizeRelativePath(event.data.path.text),
      line: event.data.line_number,
      preview: (event.data.lines?.text ?? "").trimEnd(),
    })
  }
  return uniqueSortedResults(results)
}

function parseAstGrepJson(stdout: string) {
  if (!stdout.trim()) return []
  const parsed = parseJsonArray(stdout) as Array<{ file?: string; range?: { start?: { line?: number } }; text?: string }>
  return uniqueSortedResults(parsed.flatMap((item) => {
    if (!item.file || item.range?.start?.line === undefined) return []
    return [{ filePath: normalizeRelativePath(item.file), line: item.range.start.line + 1, preview: (item.text ?? "").split(/\r?\n/)[0]?.trimEnd() ?? "" }]
  }))
}

function parseJsonArray(stdout: string) {
  const trimmed = stdout.trim()
  const parsed = JSON.parse(trimmed) as unknown
  if (Array.isArray(parsed)) return parsed
  return [parsed]
}

function uniqueSortedResults(results: CodeSearchResult[]) {
  const byKey = new Map<string, CodeSearchResult>()
  for (const result of results) byKey.set(`${result.filePath}:${result.line}:${result.preview}`, result)
  return [...byKey.values()].sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line || left.preview.localeCompare(right.preview))
}

function normalizeRelativePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

function definitionPatterns(symbol: string) {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) throw new Error("symbol must be a valid identifier")
  return [
    `export function ${symbol}($$$) { $$$ }`,
    `function ${symbol}($$$) { $$$ }`,
    `export async function ${symbol}($$$) { $$$ }`,
    `async function ${symbol}($$$) { $$$ }`,
    `export class ${symbol} { $$$ }`,
    `class ${symbol} { $$$ }`,
    `export interface ${symbol} { $$$ }`,
    `interface ${symbol} { $$$ }`,
    `export type ${symbol} = $$$`,
    `type ${symbol} = $$$`,
    `export const ${symbol} = $$$`,
    `const ${symbol} = $$$`,
    `export let ${symbol} = $$$`,
    `let ${symbol} = $$$`,
    `export var ${symbol} = $$$`,
    `var ${symbol} = $$$`,
  ]
}

function languageToFileType(language: string | undefined) {
  if (!language) return undefined
  if (language === "typescript") return "ts"
  if (language === "javascript") return "js"
  return language
}

function extensionsForLanguage(language: string | undefined) {
  if (language === "typescript") return new Set([".ts", ".tsx"])
  if (language === "javascript") return new Set([".js", ".jsx", ".mjs", ".cjs"])
  return codeExtensions
}

function extractSymbols(text: string) {
  const symbols: RepoMapSymbol[] = []
  const lines = text.split(/\r?\n/)
  const declarationPattern = /^\s*(?:export\s+)?(?:default\s+)?(async\s+function|function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b(.*)$/
  const methodPattern = /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^ {]+)?\s*\{?\s*$/
  const excludedMethods = new Set(["if", "for", "while", "switch", "catch", "function"])
  for (const [index, line] of lines.entries()) {
    const declaration = line.match(declarationPattern)
    if (declaration) {
      symbols.push({ name: declaration[2] ?? "", kind: normalizeSymbolKind(declaration[1] ?? ""), line: index + 1, signature: cleanSignature(line) })
      continue
    }
    const method = line.match(methodPattern)
    if (method && !excludedMethods.has(method[1] ?? "")) {
      symbols.push({ name: method[1] ?? "", kind: "method", line: index + 1, signature: cleanSignature(line) })
    }
  }
  return symbols
}

function normalizeSymbolKind(kind: string) {
  return kind.replace(/^async\s+/, "")
}

function cleanSignature(line: string) {
  return line.trim().replace(/\s*\{.*$/, "").replace(/\s+/g, " ")
}

async function readCachedRepoMap(cachePath: string) {
  try {
    const parsed = JSON.parse(await Bun.file(cachePath).text()) as RepoMapResult
    if (!Array.isArray(parsed.entries)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function projectIgnoresEasyCode(root: string) {
  const text = await Bun.file(path.join(root, ".gitignore")).text().catch(() => "")
  return text.split(/\r?\n/).map((line) => line.trim()).some((line) => line === ".easycode" || line === ".easycode/" || line === "/.easycode" || line === "/.easycode/")
}

function repoMapCacheValid(cached: RepoMapResult, expected: { root: string; dir: string; generatorVersion: string; toolVersions: Record<string, string>; files: Array<{ filePath: string; mtimeMs: number; size: number }> }) {
  if (cached.root !== expected.root || cached.dir !== expected.dir || cached.generatorVersion !== expected.generatorVersion) return false
  if (JSON.stringify(cached.toolVersions) !== JSON.stringify(expected.toolVersions)) return false
  if (cached.entries.length !== expected.files.length) return false
  const entries = new Map(cached.entries.map((entry) => [entry.filePath, entry]))
  return expected.files.every((file) => {
    const entry = entries.get(file.filePath)
    return entry && entry.mtimeMs === file.mtimeMs && entry.size === file.size
  })
}

function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ""
}

function commandFailure(command: string, result: CommandResult) {
  return `${command} failed with exit code ${result.exitCode}: ${firstLine(result.stderr) || firstLine(result.stdout) || "no output"}`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function scoreAndFilterRepoMap(map: RepoMapResult, query: string): RepoMapResult {
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
      let matched = false
      for (const term of terms) {
        if (nameLower.includes(term)) {
          matched = true
          symbolScore += 5
          if (nameLower === term) {
            symbolScore += 10
          }
        }
      }
      return matched
    })

    const totalScore = pathScore + symbolScore
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
