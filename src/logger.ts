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
  logger(sanitizeLogEvent({ at: Date.now(), ...event }))
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
    const safeEvent = sanitizeLogEvent(event)
    safeAppendFile(filePath, `${JSON.stringify(safeEvent)}\n`)
    if (safeEvent.type === "provider" && safeEvent.name === "provider.transcript") {
      transcriptTurn += 1
      safeAppendFile(transcriptFilePath, formatTranscriptTurn(transcriptTurn, safeEvent, previousTranscriptInput))
      previousTranscriptInput = stringDetail(safeEvent.detail?.input)
      return
    }
    if (safeEvent.type === "provider" && safeEvent.name === "provider.validation_rejected") {
      safeAppendFile(transcriptFilePath, formatTranscriptValidation(safeEvent))
    }
  }) as Logger
  logger.filePath = filePath
  logger.transcriptFilePath = transcriptFilePath
  return logger
}

function safeAppendFile(filePath: string, content: string) {
  try {
    appendFileSync(filePath, content)
  } catch {
    // Logging is diagnostic-only; filesystem policy or stale file permissions
    // should not abort the user-visible run.
  }
}

export function formatLogEvent(event: LogEvent) {
  const safeEvent = sanitizeLogEvent(event)
  const line = `[easycode] ${JSON.stringify(safeEvent)}`
  if (safeEvent.type === "provider" && safeEvent.name === "provider.input_tokens") return `\x1b[1;32m${line}\x1b[0m`
  if (safeEvent.type === "provider" && (safeEvent.name === "provider.summary_request" || safeEvent.name === "provider.summary_output" || safeEvent.name === "provider.subagent_route")) return `\x1b[1;35m${line}\x1b[0m`
  if (safeEvent.type === "state" && safeEvent.name.startsWith("subagent.")) return `\x1b[1;35m${line}\x1b[0m`
  if (safeEvent.type === "provider" && (safeEvent.name === "provider.response" || safeEvent.name === "provider.response.raw")) return `\x1b[1;33m${line}\x1b[0m`
  if (safeEvent.type === "state") return `\x1b[1;36m${line}\x1b[0m`
  return line
}

export function sanitizeLogEvent(event: LogEvent): LogEvent {
  return sanitizeValue(event, new Set()) as LogEvent
}

function sanitizeValue(value: unknown, seen: Set<unknown>, key = ""): unknown {
  if (typeof value === "string") return sanitizeText(sensitiveKey(key) ? "[redacted]" : value)
  if (typeof value !== "object" || value === null) return value
  if (seen.has(value)) return "[circular]"
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen))

  const output: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = sensitiveKey(entryKey)
      ? redactSensitiveField(entryValue)
      : sanitizeValue(entryValue, seen, entryKey)
  }
  return output
}

function redactSensitiveField(value: unknown) {
  if (typeof value === "string" && /^Bearer\s+/i.test(value)) return "Bearer [redacted]"
  return "[redacted]"
}

function sensitiveKey(key: string) {
  const lower = key.toLowerCase()
  return /^(authorization|proxy-authorization)$/i.test(key)
    || /api[_-]?key|access[_-]?key|secret|password|credential/i.test(key)
    || /(^|[_-])(access[_-]?token|refresh[_-]?token|id[_-]?token|token)($|[_-])/i.test(lower)
    || /(?:access|refresh|id)token/.test(lower)
}

function sanitizeText(text: string) {
  let output = text
  for (const secret of sensitiveEnvValues()) {
    output = output.split(secret).join("[redacted]")
  }
  return output
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*[:=]\s*)[^\s"',}]+/gi, "$1[redacted]")
}

function sensitiveEnvValues() {
  return Object.entries(process.env)
    .filter(([key, value]) => Boolean(value) && sensitiveKey(key) && (value?.length ?? 0) >= 6)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length)
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
    "Reasoning",
    "",
    stringDetail(detail.reasoningContent) || "(none)",
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

function formatTranscriptValidation(event: LogEvent) {
  const detail = event.detail ?? {}
  const attempt = numberDetail(detail.attempt)
  const maxAttempts = numberDetail(detail.maxAttempts)
  const shouldRetry = booleanDetail(detail.shouldRetry)
  const status = shouldRetry ? "rejected, retrying" : "rejected, stopping"
  const suffix = attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : attempt ? ` (${attempt})` : ""
  const lines = [
    "Validation",
    "",
    `${status}${suffix}`,
  ]
  const failureText = stringDetail(detail.failureText)
  if (failureText) lines.push(failureText)
  const correction = stringDetail(detail.correction)
  if (correction) lines.push("", "Correction", "", correction)
  return `${lines.join("\n")}\n\n`
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

function numberDetail(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanDetail(value: unknown) {
  return typeof value === "boolean" ? value : false
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
