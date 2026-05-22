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

