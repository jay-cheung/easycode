import type { ToolCall } from "../message"

export type RunUiEvent =
  | { type: "run_start"; mode: string; provider: string; model?: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; callID: string; toolName: string; title: string; status: string; output: string }
  | { type: "failure"; text: string }
  | { type: "run_done"; status: string }

type Writable = {
  write(text: string): unknown
}

export class TimelineRenderer {
  private phase: "idle" | "thought" | "answer" = "idle"
  private thoughtStartedAt = 0
  private thoughtText = ""
  private answerOpen = false

  constructor(private readonly output: Writable = process.stdout) {}

  event(event: RunUiEvent) {
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
      this.output.write(`\n● ${event.call.name} ${summarizeInput(event.call.input)}\n`)
      return
    }
    if (event.type === "tool_result") {
      const icon = event.status === "succeeded" ? "✓" : event.status === "denied" ? "!" : "×"
      const preview = previewOutput(event.output)
      this.output.write(`  ${icon} ${event.title}${preview ? `\n${indent(preview, "    ")}` : ""}\n`)
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
    this.output.write(`\n● Thought\n`)
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
    this.output.write(`\n● Answer\n`)
  }

  private closeAnswer() {
    if (!this.answerOpen) return
    this.output.write("\n")
    this.answerOpen = false
    if (this.phase === "answer") this.phase = "idle"
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

