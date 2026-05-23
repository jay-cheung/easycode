import type { ToolCall } from "../message"

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
  | { type: "provider_metrics"; metrics: ProviderRunMetrics }
  | { type: "context_compaction"; status: "started" | "completed" | "failed"; inputMessages?: number; summaryChars?: number; elapsedMs?: number; error?: string }
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
}

type TimelineTitle = "thought" | "tool" | "answer"

const titleColors: Record<TimelineTitle, string> = {
  thought: "\x1b[36m",
  tool: "\x1b[33m",
  answer: "\x1b[32m",
}

const resetColor = "\x1b[0m"

export class TimelineRenderer {
  private phase: "idle" | "thought" | "answer" = "idle"
  private thoughtStartedAt = 0
  private thoughtText = ""
  private answerOpen = false
  private readonly colorEnabled: boolean

  constructor(private readonly output: Writable = process.stdout) {
    this.colorEnabled = output.isTTY === true
  }

  event(event: RunUiEvent) {
    if (event.type === "run_start") {
      this.closeThought()
      this.closeAnswer()
      const model = event.model ? ` ${event.model}` : ""
      this.output.write(`\n${this.title("thought", "● Model")} ${event.provider}${model} (${event.mode})\n`)
      return
    }
    if (event.type === "provider_progress") {
      const model = event.model ? ` ${event.model}` : ""
      this.output.write(`  … waiting for ${this.title("thought", `${event.provider}${model}`)} after ${formatDuration(event.elapsedMs)}\n`)
      return
    }
    if (event.type === "provider_metrics") {
      this.closeThought()
      this.closeAnswer()
      this.output.write(formatProviderMetrics(event.metrics, (text) => this.title("thought", text)))
      return
    }
    if (event.type === "context_compaction") {
      this.closeThought()
      this.closeAnswer()
      if (event.status === "started") {
        const count = event.inputMessages === undefined ? "" : `, messages=${event.inputMessages}`
        this.output.write(`\n${this.title("tool", "● Context compaction")} summarizing older context${count}\n`)
      } else if (event.status === "completed") {
        const elapsed = event.elapsedMs === undefined ? "" : ` (${formatDuration(event.elapsedMs)})`
        const summary = event.summaryChars === undefined ? "" : `, summary_chars=${event.summaryChars}`
        this.output.write(`  ✓ ${this.title("tool", "Context compacted")}${elapsed}${summary}\n`)
      } else {
        const elapsed = event.elapsedMs === undefined ? "" : ` after ${formatDuration(event.elapsedMs)}`
        this.output.write(`  × ${this.title("tool", "Context compaction failed")}${elapsed}${event.error ? `: ${event.error}` : ""}\n`)
      }
      return
    }
    if (event.type === "repo_map") {
      this.closeThought()
      this.closeAnswer()
      if (event.status === "succeeded") {
        const cache = event.cacheHit ? "cache hit" : "refreshed"
        const relevant = event.relevantFiles === undefined ? "" : `, relevant=${event.relevantFiles}`
        this.output.write(`\n${this.title("tool", "● repo_map prewarm")} ${cache}, files=${event.files ?? 0}${relevant}, path=${event.cachePath ?? "-"}\n`)
      } else {
        this.output.write(`\n${this.title("tool", "● repo_map prewarm")} failed${event.error ? `: ${event.error}` : ""}\n`)
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
      this.output.write(event.text)
      return
    }
    if (event.type === "tool_call") {
      this.closeThought()
      this.closeAnswer()
      this.output.write(`\n${this.title("tool", `● ${event.call.name}`)} ${summarizeInput(event.call.input)}\n`)
      return
    }
    if (event.type === "tool_progress") {
      this.output.write(`  … ${this.title("tool", event.toolName)} still running after ${formatDuration(event.elapsedMs)}\n`)
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
      this.output.write(event.text)
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
    this.output.write(`\n${this.title("thought", "● Thought")}\n`)
  }

  private closeThought() {
    if (this.phase !== "thought") return
    const elapsed = Math.max(1, Math.round((Date.now() - this.thoughtStartedAt) / 1000))
    if (this.thoughtText && !this.thoughtText.endsWith("\n")) this.output.write("\n")
    this.output.write(`  Thought for ${elapsed}s\n`)
    this.phase = "idle"
  }

  private openAnswer() {
    if (this.phase === "answer") return
    this.phase = "answer"
    this.answerOpen = true
    this.output.write(`\n${this.title("answer", "● Answer")}\n`)
  }

  private closeAnswer() {
    if (!this.answerOpen) return
    this.output.write("\n")
    this.answerOpen = false
    if (this.phase === "answer") this.phase = "idle"
  }

  private title(type: TimelineTitle, text: string) {
    if (!this.colorEnabled) return text
    return `${titleColors[type]}${text}${resetColor}`
  }
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

function formatProviderMetrics(metrics: ProviderRunMetrics, title: (text: string) => string) {
  const model = metrics.model ? ` ${metrics.model}` : ""
  const firstResponse = metrics.firstResponseMs === undefined ? "-" : formatDuration(metrics.firstResponseMs)
  const speed = metrics.outputTokensPerSecond === undefined ? "-" : `${formatNumber(metrics.outputTokensPerSecond)}/s`
  const total = metrics.totalTokens === undefined ? "" : ` total=${formatInteger(metrics.totalTokens)}`
  const reasoning = metrics.reasoningTokens === undefined ? "" : ` reasoning=${formatInteger(metrics.reasoningTokens)}`
  return [
    `\n${title("● Metrics")}\n`,
    `  provider ${metrics.provider}${model} · calls=${metrics.calls} · latency=${formatDuration(metrics.providerElapsedMs)} · ttft=${firstResponse} · output_rate=${speed}\n`,
    `  usage input=${formatInteger(metrics.inputTokens)} cached=${formatInteger(metrics.cacheHitTokens)} miss=${formatInteger(metrics.cacheMissTokens)} hit_rate=${formatPercent(metrics.hitRate)} output=${formatInteger(metrics.outputTokens)}${reasoning}${total}\n`,
    `  cost effective=${formatNumber(metrics.effectiveCost)} per_1M(cache_hit=${formatRate(metrics.rates.inputCacheHit)} cache_miss=${formatRate(metrics.rates.inputCacheMiss)} output=${formatRate(metrics.rates.output)})\n`,
  ].join("")
}

function formatInteger(value: number) {
  if (!Number.isFinite(value)) return "0"
  return Math.round(value).toLocaleString("en-US")
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0.0%"
  return `${(value * 100).toFixed(1)}%`
}

function formatRate(value: number) {
  if (!Number.isFinite(value)) return "0"
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 })
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0"
  if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(2)
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 })
}
