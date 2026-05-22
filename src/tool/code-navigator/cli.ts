import path from "node:path"
import { mkdir, readdir, stat } from "node:fs/promises"
import type { Sandbox } from "../../sandbox"
import { codeExtensions, defaultReadLineLimit, ignoredDirs, repoMapCachePath, repoMapGeneratorVersion } from "./constants"
import { commandFailure, defaultRunner, firstLine, getRgPath } from "./commands"
import { definitionPatterns, escapeRegExp, extensionsForLanguage, fileTypeArgs, languageToFileType, normalizeMaxResults, clampInt } from "./language"
import { parseAstGrepJson, parseRgJson, uniqueSortedResults } from "./parsing"
import { extractSymbols, hashText, projectIgnoresEasyCode, readCachedRepoMap, repoMapCacheValid, scoreAndFilterRepoMap } from "./repo-map"
import type { CodeNavigator, CodeRange, CodeSearchResult, CommandRunner, RepoMapEntry, RepoMapResult } from "./types"

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

