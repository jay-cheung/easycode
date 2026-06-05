import type { CodeSearchResult } from "./types"

export function parseRgJson(stdout: string) {
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

export function parseAstGrepJson(stdout: string) {
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

export function uniqueSortedResults(results: CodeSearchResult[]) {
  const byKey = new Map<string, CodeSearchResult>()
  for (const result of results) byKey.set(`${result.filePath}:${result.line}:${result.preview}`, result)
  return [...byKey.values()].sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line || left.preview.localeCompare(right.preview))
}

export function normalizeRelativePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

type SearchMaskState = {
  blockComment: boolean
  quote?: "'" | "\"" | "`"
  tripleQuote?: "'''" | "\"\"\""
}

export function maskSearchableLines(text: string) {
  const lines = text.split(/\r?\n/)
  const state: SearchMaskState = { blockComment: false }
  return lines.map((line) => maskSearchableLine(line, state))
}

function maskSearchableLine(line: string, state: SearchMaskState) {
  let output = ""
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? ""
    const next = line[index + 1] ?? ""
    const nextThree = line.slice(index, index + 3)

    if (state.blockComment) {
      output += " "
      if (char === "*" && next === "/") {
        output += " "
        state.blockComment = false
        index += 1
      }
      continue
    }

    if (state.tripleQuote) {
      output += " "
      if (nextThree === state.tripleQuote) {
        output += "  "
        state.tripleQuote = undefined
        index += 2
      }
      continue
    }

    if (state.quote) {
      output += " "
      if (char === "\\") {
        if (index + 1 < line.length) {
          output += " "
          index += 1
        }
        continue
      }
      if (char === state.quote) state.quote = undefined
      continue
    }

    if (char === "/" && next === "/") break
    if (char === "#") break
    if (char === "/" && next === "*") {
      output += "  "
      state.blockComment = true
      index += 1
      continue
    }
    if (nextThree === "'''" || nextThree === "\"\"\"") {
      output += "   "
      state.tripleQuote = nextThree as "'''" | "\"\"\""
      index += 2
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      output += " "
      state.quote = char
      continue
    }
    output += char
  }
  return output
}
