import type { ToolCall } from "../message"
import { languageLocale, uiText, type UiLanguage } from "../i18n"

export type ProviderRunMetrics = {
  provider: string
  model?: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  totalTokens?: number
  reasoningTokens?: number
  hitRate: number
  providerElapsedMs: number
  firstResponseMs?: number
  outputTokensPerSecond?: number
  effectiveCost: number
  rates: {
    inputCacheHit: number
    inputCacheMiss: number
    output: number
  }
}

export type RunUiEvent =
  | { type: "run_start"; mode: string; provider: string; model?: string }
  | { type: "provider_progress"; provider: string; model?: string; elapsedMs: number }
  | { type: "provider_metrics"; metrics: ProviderRunMetrics; interim?: boolean }
  | { type: "context_compaction"; status: "started" | "completed" | "failed"; inputMessages?: number; summaryChars?: number; summaryTokens?: number; elapsedMs?: number; error?: string }
  | { type: "repo_map"; status: "succeeded" | "failed"; cacheHit?: boolean; files?: number; relevantFiles?: number; cachePath?: string; error?: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_progress"; callID: string; toolName: string; elapsedMs: number }
  | { type: "tool_result"; callID: string; toolName: string; title: string; status: string; output: string; durationMs?: number }
  | { type: "failure"; text: string }
  | { type: "run_done"; status: string }

type Writable = {
  write(text: string): unknown
  isTTY?: boolean
  columns?: number
}

type TimelineTitle = "thought" | "tool" | "answer"

const titleColors: Record<TimelineTitle, string> = {
  thought: "\x1b[36m",
  tool: "\x1b[33m",
  answer: "\x1b[32m",
}

const resetColor = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[2m"
const inlineCode = "\x1b[90m"

export class TimelineRenderer {
  private phase: "idle" | "thought" | "answer" = "idle"
  private thoughtStartedAt = 0
  private thoughtText = ""
  private answerOpen = false
  private answerMarkdown: MarkdownLineRenderer | undefined
  private readonly colorEnabled: boolean
  private language: UiLanguage

  constructor(private readonly output: Writable = process.stdout, language: UiLanguage = "en") {
    this.colorEnabled = output.isTTY === true
    this.language = language
  }

  setLanguage(language: UiLanguage) {
    this.language = language
  }

  event(event: RunUiEvent) {
    const copy = uiText(this.language)
    if (event.type === "run_start") {
      this.closeThought()
      this.closeAnswer()
      const model = event.model ? ` ${event.model}` : ""
      this.output.write(`\n${this.title("thought", copy.timelineModel)} ${event.provider}${model} (${event.mode})\n`)
      return
    }
    if (event.type === "provider_progress") {
      if (event.elapsedMs <= 0) return
      const model = event.model ? ` ${event.model}` : ""
      this.output.write(copy.timelineWaitingFor(this.title("thought", `${event.provider}${model}`), formatDuration(event.elapsedMs)))
      return
    }
    if (event.type === "provider_metrics") {
      if (event.interim) return
      this.closeThought()
      this.closeAnswer()
      this.output.write(formatProviderMetrics(event.metrics, copy, this.language, (text) => this.title("thought", text)))
      return
    }
    if (event.type === "context_compaction") {
      this.closeThought()
      this.closeAnswer()
      if (event.status === "started") {
        const count = event.inputMessages === undefined ? "" : `, messages=${event.inputMessages}`
        this.output.write(`\n${this.title("tool", copy.timelineContextCompactionStart(count))}\n`)
      } else if (event.status === "completed") {
        const elapsed = event.elapsedMs === undefined ? "" : ` (${formatDuration(event.elapsedMs)})`
        const summary = event.summaryChars === undefined ? "" : `, summary_chars=${event.summaryChars}`
        const tokens = event.summaryTokens === undefined ? "" : `, summary_tokens=${event.summaryTokens}`
        this.output.write(copy.timelineContextCompactionDone(elapsed, summary, tokens))
      } else {
        const elapsed = event.elapsedMs === undefined ? "" : ` after ${formatDuration(event.elapsedMs)}`
        this.output.write(copy.timelineContextCompactionFailed(elapsed, event.error ? `: ${event.error}` : ""))
      }
      return
    }
    if (event.type === "repo_map") {
      this.closeThought()
      this.closeAnswer()
      if (event.status === "succeeded") {
        const cache = event.cacheHit ? "cache hit" : "refreshed"
        const relevant = event.relevantFiles === undefined ? "" : `, relevant=${event.relevantFiles}`
        this.output.write(`\n${this.title("tool", copy.timelineRepoMapSuccess(cache, event.files ?? 0, relevant, event.cachePath ?? "-"))}\n`)
      } else {
        this.output.write(`\n${this.title("tool", copy.timelineRepoMapFailed(event.error ? `: ${event.error}` : ""))}\n`)
      }
      return
    }
    if (event.type === "reasoning_delta") {
      this.openThought()
      this.thoughtText += event.text
      this.output.write(event.text)
      return
    }
    if (event.type === "text_delta") {
      this.closeThought()
      this.openAnswer()
      this.answerMarkdown?.write(event.text)
      return
    }
    if (event.type === "tool_call") {
      this.closeThought()
      this.closeAnswer()
      this.output.write(`\n${this.title("tool", `● ${event.call.name}`)} ${summarizeInput(event.call.input)}\n`)
      return
    }
    if (event.type === "tool_progress") {
      this.output.write(uiText(this.language).timelineToolRunning(this.title("tool", event.toolName), formatDuration(event.elapsedMs)))
      return
    }
    if (event.type === "tool_result") {
      const icon = event.status === "succeeded" ? "✓" : event.status === "denied" ? "!" : "×"
      const preview = previewOutput(event.output)
      const duration = event.durationMs === undefined ? "" : ` (${formatDuration(event.durationMs)})`
      this.output.write(`  ${icon} ${this.title("tool", event.title)}${duration}${preview ? `\n${indent(preview, "    ")}` : ""}\n`)
      return
    }
    if (event.type === "failure") {
      this.closeThought()
      this.openAnswer()
      this.answerMarkdown?.write(event.text)
      return
    }
    if (event.type === "run_done") this.finish()
  }

  finish() {
    this.closeThought()
    this.closeAnswer()
  }

  private openThought() {
    if (this.phase === "thought") return
    this.closeAnswer()
    this.phase = "thought"
    this.thoughtStartedAt = Date.now()
    this.thoughtText = ""
    this.output.write(`\n${this.title("thought", uiText(this.language).timelineThought)}\n`)
  }

  private closeThought() {
    if (this.phase !== "thought") return
    const elapsed = Math.max(1, Math.round((Date.now() - this.thoughtStartedAt) / 1000))
    if (this.thoughtText && !this.thoughtText.endsWith("\n")) this.output.write("\n")
    this.output.write(uiText(this.language).timelineThoughtDone(elapsed))
    this.phase = "idle"
  }

  private openAnswer() {
    if (this.phase === "answer") return
    this.phase = "answer"
    this.answerOpen = true
    this.answerMarkdown = new MarkdownLineRenderer((text) => this.output.write(text), this.colorEnabled, this.output.columns)
    this.output.write(`\n${this.title("answer", uiText(this.language).timelineAnswer)}\n`)
  }

  private closeAnswer() {
    if (!this.answerOpen) return
    this.answerMarkdown?.finish()
    this.answerMarkdown = undefined
    this.output.write("\n")
    this.answerOpen = false
    if (this.phase === "answer") this.phase = "idle"
  }

  private title(type: TimelineTitle, text: string) {
    if (!this.colorEnabled) return text
    return `${titleColors[type]}${text}${resetColor}`
  }
}

class MarkdownLineRenderer {
  private pending = ""
  private inFence = false
  private tableCandidate: string | undefined
  private tableLines: string[] | undefined

  constructor(
    private readonly writeOutput: (text: string) => unknown,
    private readonly colorEnabled: boolean,
    private readonly maxWidth = 100,
  ) {}

  write(text: string) {
    this.pending += text
    const lines = this.pending.split(/\n/)
    this.pending = lines.pop() ?? ""
    for (const line of lines) this.writeRenderedLine(line)
  }

  finish() {
    if (this.pending) {
      this.processLine(this.pending)
      this.pending = ""
    }
    this.flushTable()
    this.flushTableCandidate()
  }

  private writeRenderedLine(line: string) {
    this.processLine(line.replace(/\r$/, ""))
  }

  private processLine(line: string) {
    if (!this.inFence) {
      if (this.tableLines) {
        if (isTableRow(line)) {
          this.tableLines.push(line)
          return
        }
        this.flushTable()
        this.processLine(line)
        return
      }

      if (this.tableCandidate !== undefined) {
        if (isTableSeparator(line)) {
          this.tableLines = [this.tableCandidate, line]
          this.tableCandidate = undefined
          return
        }
        this.flushTableCandidate()
        this.processLine(line)
        return
      }

      if (isTableRow(line) && !isTableSeparator(line)) {
        this.tableCandidate = line
        return
      }
    }

    const rendered = this.renderLine(line)
    if (rendered !== undefined) this.writeOutput(`${rendered}\n`)
  }

  private flushTableCandidate() {
    if (this.tableCandidate === undefined) return
    const rendered = this.renderLine(this.tableCandidate)
    if (rendered !== undefined) this.writeOutput(`${rendered}\n`)
    this.tableCandidate = undefined
  }

  private flushTable() {
    if (!this.tableLines) return
    for (const line of renderTable(this.tableLines, (text) => this.renderInline(text), (text) => this.style(text, bold), this.maxWidth)) this.writeOutput(`${line}\n`)
    this.tableLines = undefined
  }

  private renderLine(line: string): string | undefined {
    const fence = line.match(/^\s*```/)
    if (fence) {
      this.inFence = !this.inFence
      return undefined
    }

    if (this.inFence) return this.style(`    ${line}`, dim)

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) return this.style(this.renderInline(heading[2] ?? ""), bold)

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (unordered) return `${unordered[1] ?? ""}- ${this.renderInline(unordered[2] ?? "")}`

    const ordered = line.match(/^(\s*\d+\.)\s+(.+)$/)
    if (ordered) return `${ordered[1] ?? ""} ${this.renderInline(ordered[2] ?? "")}`

    const quote = line.match(/^(\s*)>\s?(.*)$/)
    if (quote) return this.style(`${quote[1] ?? ""}> ${this.renderInline(quote[2] ?? "")}`, dim)

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return "-----"

    return this.renderInline(line)
  }

  private renderInline(text: string) {
    let rendered = text.replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 ($2)")
    rendered = rendered.replace(/`([^`\n]+)`/g, (_match, code: string) => this.style(code, inlineCode))
    rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, (_match, content: string) => this.style(content, bold))
    rendered = rendered.replace(/__([^_\n]+)__/g, (_match, content: string) => this.style(content, bold))
    return rendered
  }

  private style(text: string, code: string) {
    if (!this.colorEnabled || !text) return text
    return `${code}${text}${resetColor}`
  }
}

type TableAlign = "left" | "right" | "center"

function isTableRow(line: string) {
  if (!line.includes("|")) return false
  return parseTableRow(line).length > 1
}

function isTableSeparator(line: string) {
  const cells = parseTableRow(line)
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function parseTableRow(line: string) {
  let trimmed = line.trim()
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1)
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1)
  return trimmed.split("|").map((cell) => cell.trim())
}

function renderTable(lines: string[], renderInline: (text: string) => string, renderHeader: (text: string) => string, maxWidth: number) {
  const header = parseTableRow(lines[0] ?? "")
  const separator = parseTableRow(lines[1] ?? "")
  const rows = lines.slice(2).map(parseTableRow)
  const columnCount = Math.max(header.length, separator.length, ...rows.map((row) => row.length))
  const alignments = Array.from({ length: columnCount }, (_, index): TableAlign => tableAlignment(separator[index] ?? ""))
  const plainRows = [header.map((cell) => plainInline(renderHeader(cell))), ...rows.map((row) => row.map((cell) => plainInline(renderInline(cell))))]
  const naturalWidths = Array.from({ length: columnCount }, (_, index) => Math.max(...plainRows.map((row) => displayWidth(row[index] ?? "")), 0))
  const widths = fitTableWidths(naturalWidths, plainRows[0] ?? [], maxWidth)
  const output = [formatTableBorder(widths)]
  output.push(...formatWrappedTableRow(header.map((cell) => plainInline(renderHeader(cell))), widths, alignments, renderHeader))
  output.push(formatTableBorder(widths))
  for (const row of rows) output.push(...formatWrappedTableRow(row.map((cell) => plainInline(renderInline(cell))), widths, alignments))
  output.push(formatTableBorder(widths))
  return output
}

function fitTableWidths(naturalWidths: number[], header: string[], maxWidth: number) {
  const columnCount = naturalWidths.length
  const borderWidth = columnCount * 3 + 1
  const available = Math.max(columnCount * 4, Math.floor(maxWidth || 100) - borderWidth)
  const minWidths = naturalWidths.map((width, index) => Math.min(width, Math.max(4, Math.min(12, displayWidth(header[index] ?? "")))))
  const widths = naturalWidths.map((width, index) => Math.max(width, minWidths[index] ?? 4))
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    let shrinkIndex = -1
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index] <= (minWidths[index] ?? 4)) continue
      if (shrinkIndex === -1 || widths[index] > widths[shrinkIndex]) shrinkIndex = index
    }
    if (shrinkIndex === -1) break
    widths[shrinkIndex] -= 1
  }
  return widths
}

function formatWrappedTableRow(cells: string[], widths: number[], alignments: TableAlign[], styleCell: (text: string) => string = (text) => text) {
  const wrapped = widths.map((width, index) => wrapTableCell(cells[index] ?? "", width))
  const height = Math.max(...wrapped.map((cell) => cell.length), 1)
  const lines: string[] = []
  for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
    lines.push(formatTableRow(wrapped.map((cell) => styleCell(cell[lineIndex] ?? "")), widths, alignments))
  }
  return lines
}

function formatTableBorder(widths: number[]) {
  return `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`
}

function wrapTableCell(text: string, width: number) {
  if (!text) return [""]
  const lines: string[] = []
  let current = ""
  for (const char of text) {
    const next = `${current}${char}`
    if (current && displayWidth(next) > width) {
      lines.push(current.trimEnd())
      current = char.trimStart()
    } else {
      current = next
    }
  }
  lines.push(current.trimEnd())
  return lines
}

function plainInline(text: string) {
  return stripAnsi(text)
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

function tableAlignment(cell: string): TableAlign {
  const trimmed = cell.trim()
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center"
  if (trimmed.endsWith(":")) return "right"
  return "left"
}

function formatTableRow(cells: string[], widths: number[], alignments: TableAlign[]) {
  return `| ${widths.map((width, index) => padTableCell(cells[index] ?? "", width, alignments[index] ?? "left")).join(" | ")} |`
}

function padTableCell(text: string, width: number, alignment: TableAlign) {
  const extra = Math.max(0, width - displayWidth(text))
  if (alignment === "right") return `${" ".repeat(extra)}${text}`
  if (alignment === "center") {
    const left = Math.floor(extra / 2)
    return `${" ".repeat(left)}${text}${" ".repeat(extra - left)}`
  }
  return `${text}${" ".repeat(extra)}`
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) width += isWideCharacter(char) ? 2 : 1
  return width
}

function isWideCharacter(char: string) {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

function summarizeInput(input: unknown) {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const primary = record.filePath ?? record.dirPath ?? record.query ?? record.command ?? record.name
  return typeof primary === "string" && primary ? primary : ""
}

function previewOutput(output: string) {
  const trimmed = output.trim()
  if (!trimmed) return ""
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}\n[truncated ${trimmed.length - 600} chars]` : trimmed
}

function indent(text: string, prefix: string) {
  return text.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n")
}

function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s"
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`
  const seconds = durationMs / 1_000
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`
  return `${Math.round(seconds)}s`
}

function formatProviderMetrics(metrics: ProviderRunMetrics, copy: ReturnType<typeof uiText>, language: UiLanguage, title: (text: string) => string) {
  const model = metrics.model ? ` ${metrics.model}` : ""
  const firstResponse = metrics.firstResponseMs === undefined ? "-" : formatDuration(metrics.firstResponseMs)
  const speed = metrics.outputTokensPerSecond === undefined ? "-" : `${formatNumber(metrics.outputTokensPerSecond)}/s`
  const total = metrics.totalTokens === undefined ? "" : ` total=${formatInteger(metrics.totalTokens)}`
  const reasoning = metrics.reasoningTokens === undefined ? "" : ` reasoning=${formatInteger(metrics.reasoningTokens)}`
  const lines = copy.timelineMetricsBody({
    provider: metrics.provider,
    model,
    calls: metrics.calls,
    latency: formatDuration(metrics.providerElapsedMs),
    ttft: firstResponse,
    speed,
    inputTokens: formatInteger(metrics.inputTokens, language),
    cached: formatInteger(metrics.cacheHitTokens, language),
    miss: formatInteger(metrics.cacheMissTokens, language),
    hitRate: formatPercent(metrics.hitRate),
    outputTokens: formatInteger(metrics.outputTokens, language),
    reasoning,
    total,
    effectiveCost: formatNumber(metrics.effectiveCost, language),
    cacheHitRate: formatRate(metrics.rates.inputCacheHit, language),
    cacheMissRate: formatRate(metrics.rates.inputCacheMiss, language),
    outputRate: formatRate(metrics.rates.output, language),
  })
  return [
    `\n${title(copy.timelineMetrics)}\n`,
    ...lines.map((line) => `${line}\n`),
  ].join("")
}

function formatInteger(value: number, language: UiLanguage = "en") {
  if (!Number.isFinite(value)) return "0"
  return Math.round(value).toLocaleString(languageLocale(language))
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0.0%"
  return `${(value * 100).toFixed(1)}%`
}

function formatRate(value: number, language: UiLanguage = "en") {
  if (!Number.isFinite(value)) return "0"
  return value.toLocaleString(languageLocale(language), { maximumFractionDigits: 6 })
}

function formatNumber(value: number, language: UiLanguage = "en") {
  if (!Number.isFinite(value)) return "0"
  if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(2)
  return value.toLocaleString(languageLocale(language), { maximumFractionDigits: 6 })
}
