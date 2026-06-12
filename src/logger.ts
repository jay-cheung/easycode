import path from "node:path"
import { appendFileSync, mkdirSync } from "node:fs"
import { easycodeDir } from "./easycode-path"

export type LogEventType = "state" | "data" | "context" | "provider" | "tool" | "error"

export type LogEvent = {
  at: number
  type: LogEventType
  name: string
  detail?: Record<string, unknown>
}

export type Logger = ((event: LogEvent) => void) & { filePath?: string; transcriptFilePath?: string }

export type LoggerOptions = {
  root?: string
  session?: string
}

export function emitLog(logger: Logger | undefined, event: Omit<LogEvent, "at">) {
  if (!logger) return
  logger({ at: Date.now(), ...event })
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const root = options.root ?? process.cwd()
  const session = safeLogSegment(options.session ?? "default")
  const dir = path.join(easycodeDir(root), "logs", "sessions")
  const filePath = path.join(dir, `${session}.jsonl`)
  const transcriptFilePath = path.join(dir, `${session}.txt`)
  mkdirSync(dir, { recursive: true })
  let transcriptTurn = 0
  let previousTranscriptInput = ""
  const logger = ((event: LogEvent) => {
    appendFileSync(filePath, `${JSON.stringify(event)}\n`)
    if (event.type === "provider" && event.name === "provider.transcript") {
      transcriptTurn += 1
      appendFileSync(transcriptFilePath, formatTranscriptTurn(transcriptTurn, event, previousTranscriptInput))
      previousTranscriptInput = stringDetail(event.detail?.input)
    }
  }) as Logger
  logger.filePath = filePath
  logger.transcriptFilePath = transcriptFilePath
  return logger
}

export function formatLogEvent(event: LogEvent) {
  const line = `[easycode] ${JSON.stringify(event)}`
  if (event.type === "provider" && event.name === "provider.input_tokens") return `\x1b[1;32m${line}\x1b[0m`
  if (event.type === "provider" && (event.name === "provider.summary_request" || event.name === "provider.summary_output" || event.name === "provider.subagent_route")) return `\x1b[1;35m${line}\x1b[0m`
  if (event.type === "state" && event.name.startsWith("subagent.")) return `\x1b[1;35m${line}\x1b[0m`
  if (event.type === "provider" && (event.name === "provider.response" || event.name === "provider.response.raw")) return `\x1b[1;33m${line}\x1b[0m`
  if (event.type === "state") return `\x1b[1;36m${line}\x1b[0m`
  return line
}

function safeLogSegment(value: string) {
  const safe = value.trim().replace(/[^A-Za-z0-9_.-]/g, "_")
  if (!safe) return "default"
  return safe
}

function formatTranscriptTurn(turn: number, event: LogEvent, previousInput = "") {
  const detail = event.detail ?? {}
  const subagentRequestId = stringDetail(detail.subagentRequestId)
  const subagentRole = stringDetail(detail.subagentRole)
  const subagentTask = stringDetail(detail.subagentTask)
  const provider = stringDetail(detail.provider)
  const model = stringDetail(detail.model)
  const header = subagentRequestId
    ? [
        `Subagent ${subagentRequestId}`,
        subagentRole ? `role=${subagentRole}` : "",
        provider ? `provider=${provider}${model ? ` ${model}` : ""}` : "",
        subagentTask ? `task=${subagentTask}` : "",
      ].filter(Boolean).join("\n")
    : `Turn ${turn}`
  return [
    header,
    "",
    "Input",
    "",
    formatProviderInputText(stringDetail(detail.input)),
    "",
    "Output",
    "",
    "Assistant",
    "",
    stringDetail(detail.output) || "(none)",
    "",
    "Cache",
    "",
    hitRateLine(detail),
    cacheSummaryText(detail, previousInput),
    "",
  ].join("\n")
}

function cacheSummaryText(detail: Record<string, unknown>, previousInput: string) {
  const cacheHitTokens = usageNumber(detail, "cacheHitTokens") ?? 0
  const currentInput = stringDetail(detail.input)
  const commonPrefix = previousInput ? commonPrefixLength(previousInput, currentInput) : 0
  const lines = [
    `provider reported cached tokens: ${cacheHitTokens}`,
    "exact cached text span: unavailable from provider",
  ]
  if (previousInput) lines.push(`common prefix with previous turn: chars=${commonPrefix}, estimated_tokens=${estimateTextTokens(currentInput.slice(0, commonPrefix))}`)
  return lines.join("\n")
}

function hitRateLine(detail: Record<string, unknown>) {
  const inputTokens = usageNumber(detail, "inputTokens")
  const cacheHitTokens = usageNumber(detail, "cacheHitTokens") ?? 0
  const cacheMissTokens = usageNumber(detail, "cacheMissTokens")
  const outputTokens = usageNumber(detail, "outputTokens")
  const hitRate = inputTokens && inputTokens > 0 ? `${((cacheHitTokens / inputTokens) * 100).toFixed(1)}%` : "n/a"
  return [
    hitRate,
    `cache hit: ${cacheHitTokens > 0 ? "yes" : "no"}`,
    inputTokens === undefined ? undefined : `input=${inputTokens}`,
    `cached=${cacheHitTokens}`,
    cacheMissTokens === undefined ? undefined : `miss=${cacheMissTokens}`,
    outputTokens === undefined ? undefined : `output=${outputTokens}`,
  ].filter((part): part is string => Boolean(part)).join(", ")
}

function usageNumber(detail: Record<string, unknown>, key: string) {
  const usage = detail.usage
  if (!usage || typeof usage !== "object") return undefined
  const value = (usage as Record<string, unknown>)[key]
  return typeof value === "number" ? value : undefined
}

function stringDetail(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)
}

function formatProviderInputText(input: string) {
  const messages = parseRenderedProviderInput(input)
  if (messages.length === 0) return input || "(none)"
  return messages.map((message) => `${roleTitle(message.role)}\n\n${message.content || "(empty)"}`).join("\n\n")
}

function parseRenderedProviderInput(input: string) {
  const messages: Array<{ role: string; content: string }> = []
  const pattern = /<message index="\d+" role="([^"]+)">\n([\s\S]*?)\n<\/message>(?:\n\n|$)/g
  let match: RegExpExecArray | null
  let consumed = 0
  while ((match = pattern.exec(input))) {
    if (input.slice(consumed, match.index).trim()) return []
    messages.push({ role: match[1], content: match[2] })
    consumed = pattern.lastIndex
  }
  if (input.slice(consumed).trim()) return []
  return messages
}

function roleTitle(role: string) {
  if (role === "system") return "System"
  if (role === "user") return "User"
  if (role === "assistant") return "Assistant"
  if (role === "tool") return "Tool"
  return role ? role[0].toUpperCase() + role.slice(1) : "Message"
}

function commonPrefixLength(left: string, right: string) {
  let index = 0
  const length = Math.min(left.length, right.length)
  while (index < length && left[index] === right[index]) index += 1
  return index
}

function estimateTextTokens(text: string) {
  let tokens = 0
  for (const char of text) tokens += /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char) ? 0.6 : 0.3
  return Math.ceil(tokens)
}
