export type AgentMode = "build" | "plan"
export type PermissionAction = "deny" | "ask" | "allow"
export type MessageRole = "system" | "user" | "assistant" | "tool"
export type ToolCallStatus = "pending" | "running" | "succeeded" | "failed" | "denied"

export type ToolCall = {
  id: string
  name: string
  input: unknown
  rawArguments?: string
  reasoningContent?: string
}

export type ImageSource = { type: "path"; path: string; mimeType: string } | { type: "url"; url: string; mimeType?: string }
export type TextPart = { type: "text"; text: string }
export type ReasoningPart = { type: "reasoning"; text: string }
export type ImagePart = { type: "image"; source: ImageSource }
export type SummaryPart = { type: "summary"; text: string }
export type ToolCallPart = { type: "tool_call"; call: ToolCall; status: ToolCallStatus }
export type ToolResultPart = {
  type: "tool_result"
  callID: string
  toolName: string
  status: Exclude<ToolCallStatus, "pending" | "running">
  output: string
  metadata: Record<string, unknown>
}

export type MessagePart = TextPart | ReasoningPart | ImagePart | SummaryPart | ToolCallPart | ToolResultPart

export type Message = {
  id: string
  role: MessageRole
  parts: MessagePart[]
  createdAt: number
}

export type ProviderInputMessage = {
  role: MessageRole
  content: string
  parts?: MessagePart[]
}

export type ToolInvocation = {
  callID: string
  toolName: string
  input: unknown
  status: Exclude<ToolCallStatus, "pending" | "running"> | "pending"
  output?: string
  metadata?: Record<string, unknown>
}

let idCounter = 0
const messageRoles = new Set<MessageRole>(["system", "user", "assistant", "tool"])
const toolCallStatuses = new Set<ToolCallStatus>(["pending", "running", "succeeded", "failed", "denied"])
const toolResultStatuses = new Set<ToolResultPart["status"]>(["succeeded", "failed", "denied"])

export function createID(prefix: string) {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  return value
}

function normalizeMessages(messages: Message[]) {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) => {
    const normalized = normalizeMessage(message)
    return normalized ? [normalized] : []
  })
}

function normalizeMessage(message: unknown): Message | undefined {
  if (!isRecord(message)) return undefined
  if (!messageRoles.has(message.role as MessageRole)) return undefined
  const originalParts = message.parts
  const normalizedParts = normalizeMessageParts(originalParts)
  if (typeof message.id === "string" &&
    message.id &&
    typeof message.createdAt === "number" &&
    Number.isFinite(message.createdAt) &&
    Array.isArray(originalParts) &&
    normalizedParts.length === originalParts.length &&
    normalizedParts.every((part, index) => part === originalParts[index])) {
    return message as Message
  }
  return {
    id: typeof message.id === "string" && message.id ? message.id : createID("msg"),
    role: message.role as MessageRole,
    parts: normalizedParts,
    createdAt: typeof message.createdAt === "number" && Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
  }
}

function normalizeMessageParts(parts: unknown): MessagePart[] {
  if (!Array.isArray(parts)) return []
  return parts.flatMap(normalizeMessagePart)
}

function normalizeMessagePart(part: unknown): MessagePart[] {
  if (!isRecord(part)) return []
  if (part.type === "text" && typeof part.text === "string") return [part as TextPart]
  if (part.type === "reasoning" && typeof part.text === "string") return [part as ReasoningPart]
  if (part.type === "summary" && typeof part.text === "string") return [part as SummaryPart]
  if (part.type === "image" && isImageSource(part.source)) return [part as ImagePart]
  if (part.type === "tool_call" && isToolCall(part.call)) {
    const status = toolCallStatuses.has(part.status as ToolCallStatus) ? part.status as ToolCallStatus : "pending"
    if (status === part.status) return [part as ToolCallPart]
    return [{ type: "tool_call", call: part.call, status }]
  }
  if (part.type === "tool_result" &&
    typeof part.callID === "string" &&
    typeof part.toolName === "string" &&
    typeof part.output === "string" &&
    toolResultStatuses.has(part.status as ToolResultPart["status"])) {
    if (isRecord(part.metadata)) return [part as ToolResultPart]
    return [{
      type: "tool_result",
      callID: part.callID,
      toolName: part.toolName,
      status: part.status as ToolResultPart["status"],
      output: part.output,
      metadata: isRecord(part.metadata) ? part.metadata : {},
    }]
  }
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
}

function isToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || !value.id) return false
  if (typeof value.name !== "string" || !value.name) return false
  if (value.rawArguments !== undefined && typeof value.rawArguments !== "string") return false
  if (value.reasoningContent !== undefined && typeof value.reasoningContent !== "string") return false
  return true
}

function isImageSource(value: unknown): value is ImageSource {
  if (!isRecord(value)) return false
  if (value.type === "path") return typeof value.path === "string" && typeof value.mimeType === "string"
  if (value.type === "url") return typeof value.url === "string" && (value.mimeType === undefined || typeof value.mimeType === "string")
  return false
}

export function textPart(text: string): TextPart {
  return { type: "text", text: requireString(text, "text part") }
}

export function reasoningPart(text: string): ReasoningPart {
  return { type: "reasoning", text: requireString(text, "reasoning part") }
}

export function imagePart(source: ImageSource): ImagePart {
  if (!isImageSource(source)) throw new Error("image part requires a valid image source")
  return { type: "image", source }
}

export function summaryPart(text: string): SummaryPart {
  return { type: "summary", text: requireString(text, "summary part") }
}

export function toolCallPart(call: ToolCall, status: ToolCallStatus = "pending"): ToolCallPart {
  if (!isToolCall(call)) throw new Error("tool call part requires a valid tool call")
  if (!toolCallStatuses.has(status)) throw new Error(`tool call part has invalid status: ${String(status)}`)
  return { type: "tool_call", call, status }
}

export function toolResultPart(input: {
  callID: string
  toolName: string
  status: Exclude<ToolCallStatus, "pending" | "running">
  output: string
  metadata?: Record<string, unknown>
}): ToolResultPart {
  const callID = requireString(input.callID, "tool result callID")
  const toolName = requireString(input.toolName, "tool result toolName")
  const output = requireString(input.output, "tool result output")
  if (!toolResultStatuses.has(input.status)) throw new Error(`tool result has invalid status: ${String(input.status)}`)
  return {
    type: "tool_result",
    callID,
    toolName,
    status: input.status,
    output,
    metadata: isRecord(input.metadata) ? input.metadata : {},
  }
}

export function createMessage(role: MessageRole, parts: MessagePart[], id = createID("msg")): Message {
  if (!messageRoles.has(role)) throw new Error(`message role is invalid: ${String(role)}`)
  if (!Array.isArray(parts)) throw new Error("message parts must be an array")
  const normalizedParts = normalizeMessageParts(parts)
  if (normalizedParts.length !== parts.length) throw new Error("message parts contain invalid entries")
  return { id: requireString(id, "message id"), role, parts: normalizedParts, createdAt: Date.now() }
}

export function textMessage(role: MessageRole, text: string, id?: string): Message {
  return createMessage(role, [textPart(text)], id)
}

export function userMessage(text: string, images: ImagePart[] = [], id?: string): Message {
  requireString(text, "user message text")
  if (!Array.isArray(images)) throw new Error("user message images must be an array")
  const parts: MessagePart[] = []
  if (text) parts.push(textPart(text))
  parts.push(...images)
  return createMessage("user", parts, id)
}

export function toolCallMessage(call: ToolCall | ToolCall[], reasoningText?: string, text?: string): Message {
  const calls = Array.isArray(call) ? call : [call]
  const parts: MessagePart[] = []
  if (reasoningText) parts.push(reasoningPart(reasoningText))
  if (text) parts.push(textPart(text))
  parts.push(...calls.map((item) => toolCallPart(item, "pending")))
  return createMessage("assistant", parts)
}

export function toolResultMessage(input: {
  callID: string
  toolName: string
  status: Exclude<ToolCallStatus, "pending" | "running">
  output: string
  metadata?: Record<string, unknown>
}): Message {
  return createMessage("tool", [toolResultPart(input)])
}

export const protectedToolResultRedaction = "[redacted: permission-gated tool result]"
export const largeOutputLimit = 8_000
export const defaultToolResultTokenBudget = 600
const largeOutputHead = 4_000
const largeOutputTail = 3_000
const historyAssistantTextLimit = 4_000
const historyReasoningTextLimit = 1_500
const historyPlanTextLimit = 3_000
const historyToolExcerptLimit = 2_400
const historyCanonicalVersion = 1
type MessageTextOptions = {
  redactProtectedToolResults?: boolean
  truncateLargeOutputs?: boolean
  largeOutputLimit?: number
  toolResultTokenBudget?: number
  foldedToolResults?: Map<string, ToolResultFold>
}

type ToolResultFold = { reason: string; retrievalHint: string }

export function isProtectedToolResult(part: MessagePart) {
  return part.type === "tool_result" && part.metadata.permissionAction === "ask"
}

function protectedReadPath(input: unknown) {
  if (!input || typeof input !== "object") return false
  const filePath = (input as { filePath?: unknown }).filePath
  if (typeof filePath !== "string") return false
  const normalized = filePath.replaceAll("\\", "/").split("/").at(-1) ?? filePath
  return normalized === ".env" || normalized.startsWith(".env.")
}

export function redactProtectedMessages(messages: Message[]): Message[] {
  const normalized = normalizeMessages(messages)
  const protectedCallIDs = new Set<string>()
  for (const message of normalized) {
    for (const part of message.parts) {
      if (part.type === "tool_call" && part.call.name === "read" && protectedReadPath(part.call.input)) protectedCallIDs.add(part.call.id)
    }
  }
  return normalized.map((message) => redactProtectedMessage(message, protectedCallIDs))
}

export function validProviderMessageSuffix(messages: Message[]) {
  messages = normalizeMessages(messages)
  let start = 0
  while (start < messages.length && messages[start].role === "tool") start += 1
  return stripUnpairedToolExchanges(messages.slice(start))
}

function stripUnpairedToolExchanges(messages: Message[]): Message[] {
  const preserved: Message[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === "tool") continue
    if (message.role !== "assistant") {
      preserved.push(message)
      continue
    }

    const toolCalls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call")
    if (toolCalls.length === 0) {
      preserved.push(message)
      continue
    }

    const followingResultIDs = new Set<string>()
    let next = index + 1
    while (next < messages.length && messages[next].role === "tool") {
      for (const part of messages[next].parts) {
        if (part.type === "tool_result") followingResultIDs.add(part.callID)
      }
      next += 1
    }

    const assistantParts = message.parts.filter((part) => part.type !== "tool_call" || followingResultIDs.has(part.call.id))
    const keptCallIDs = new Set(assistantParts.flatMap((part) => (part.type === "tool_call" ? [part.call.id] : [])))
    if (assistantParts.length > 0) preserved.push({ ...message, parts: assistantParts })

    for (let toolIndex = index + 1; toolIndex < next; toolIndex += 1) {
      const toolMessage = messages[toolIndex]
      const toolParts = toolMessage.parts.filter((part) => part.type !== "tool_result" || keptCallIDs.has(part.callID))
      if (toolParts.length > 0) preserved.push({ ...toolMessage, parts: toolParts })
    }
    index = next - 1
  }
  return preserved
}

export function redactProtectedMessage(message: Message, protectedCallIDs = new Set<string>()): Message {
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (!isProtectedToolResult(part) && !(part.type === "tool_result" && protectedCallIDs.has(part.callID))) return part
      if (part.type !== "tool_result") return part
      return {
        ...part,
        output: protectedToolResultRedaction,
        metadata: { ...part.metadata, redacted: true },
      }
    }),
  }
}

export function canonicalizeHistoryMessages(messages: Message[]) {
  return normalizeMessages(messages).map((message) => canonicalizeHistoryMessage(message))
}

export function canonicalizeHistoryMessage(message: Message): Message {
  message = normalizeMessage(message) ?? createMessage("assistant", [])
  const parts = message.parts.map((part) => canonicalizeHistoryPart(message.role, part))
  if (parts.every((part, index) => part === message.parts[index])) return message
  return { ...message, parts }
}

export function canonicalizeAssistantHistory(reasoningText: string, text: string) {
  const parts: MessagePart[] = []
  if (reasoningText) parts.push(reasoningPart(truncateLargeOutput(reasoningText, true, historyReasoningTextLimit)))
  if (text) parts.push(textPart(text))
  const canonical = canonicalizeHistoryMessage(createMessage("assistant", parts.length > 0 ? parts : [textPart("")], "history_preview"))
  return {
    reasoningText: canonical.parts.filter((part): part is ReasoningPart => part.type === "reasoning").map((part) => part.text).join("\n"),
    text: canonical.parts.filter((part): part is TextPart => part.type === "text").map((part) => part.text).join("\n"),
  }
}

function canonicalizeHistoryPart(role: MessageRole, part: MessagePart): MessagePart {
  if (part.type === "tool_result") return canonicalizeToolResultPart(part)
  if (role === "assistant" && part.type === "text") {
    const limit = /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(part.text) ? historyPlanTextLimit : historyAssistantTextLimit
    const text = truncateLargeOutput(part.text, true, limit)
    return text === part.text ? part : { ...part, text }
  }
  // DeepSeek thinking mode requires exact reasoning_content replay across turns.
  if (role === "assistant" && part.type === "reasoning") return part
  return part
}

function canonicalizeToolResultPart(part: ToolResultPart): ToolResultPart {
  if (part.metadata.historyCanonicalVersion === historyCanonicalVersion) return part
  const rawOutput = isProtectedToolResult(part) ? protectedToolResultRedaction : part.output
  const compacted = compactToolResultOutput(part, rawOutput)
  const rawOutputLength = typeof part.metadata.rawOutputLength === "number" ? part.metadata.rawOutputLength : part.output.length
  return {
    ...part,
    output: compacted.output,
    metadata: {
      ...part.metadata,
      ...(isProtectedToolResult(part) ? { redacted: true } : {}),
      historyCanonicalVersion,
      historyCompacted: compacted.compacted,
      rawOutputLength,
      historySummaryKind: compacted.kind,
    },
  }
}

function compactToolResultOutput(part: ToolResultPart, rawOutput: string): { output: string; compacted: boolean; kind: string } {
  if (part.toolName === "delegate_subagent") {
    const output = compactDelegateSubagentOutput(rawOutput)
    return { output, compacted: output !== rawOutput, kind: "delegate_subagent_compact" }
  }
  if (part.toolName === "skill") return { output: compactSkillOutput(part, rawOutput), compacted: true, kind: "skill_compact" }
  if (part.toolName === "web_search") return { output: compactWebSearchOutput(part, rawOutput), compacted: true, kind: "web_search_compact" }
  if (part.toolName === "web_fetch") return { output: compactWebFetchOutput(part, rawOutput), compacted: true, kind: "web_fetch_compact" }
  if (part.toolName === "bash") return { output: compactBashOutput(part, rawOutput), compacted: true, kind: "bash_compact" }
  if (part.toolName === "read" || part.toolName === "read_lines") return { output: compactReadOutput(part, rawOutput), compacted: true, kind: `${part.toolName}_compact` }
  if (part.toolName === "git_diff") return { output: compactGitDiffOutput(part, rawOutput), compacted: true, kind: "git_diff_compact" }
  if (part.toolName === "ledger") return { output: compactLedgerOutput(part, rawOutput), compacted: true, kind: "ledger_compact" }
  const output = truncateLargeOutput(rawOutput, true, historyToolExcerptLimit)
  return { output, compacted: output !== rawOutput, kind: output === rawOutput ? "passthrough" : "generic_truncate" }
}

function compactSkillOutput(part: ToolResultPart, _rawOutput: string) {
  const skillName = stringMetadata(part.metadata, "skillName") ?? "unknown"
  const description = stringMetadata(part.metadata, "skillDescription")
  const location = stringMetadata(part.metadata, "location")
  const artifacts = artifactMetadata(part.metadata)
  const lines = [`Loaded skill: ${skillName}`]
  if (description) lines.push(`description: ${description}`)
  if (location) lines.push(`location: ${location}`)
  if (artifacts.length > 0) {
    lines.push("inspect referenced artifacts before inventing a new workflow:")
    for (const artifact of artifacts.slice(0, 5)) lines.push(`- ${artifact.kind}: ${artifact.path}`)
    if (artifacts.length > 5) lines.push(`+${artifacts.length - 5} more artifacts omitted from persistent history`)
    const missing = artifacts.filter((artifact) => artifact.kind === "missing").length
    if (missing > 0) lines.push(`missing artifacts: ${missing}`)
  } else {
    lines.push("artifacts: none declared")
  }
  lines.push("skill body omitted from persistent history; reopen the skill file directly if more detail is needed.")
  return lines.join("\n")
}

function compactWebSearchOutput(part: ToolResultPart, rawOutput: string) {
  const query = stringMetadata(part.metadata, "query") ?? "unknown query"
  const engine = stringMetadata(part.metadata, "engine")
  const live = booleanMetadata(part.metadata, "live")
  const warning = stringMetadata(part.metadata, "warning")
  const count = numberMetadata(part.metadata, "count")
  const results = webResultMetadata(part.metadata, rawOutput)
  const shown = results.slice(0, 3)
  const lines = [`Web search: ${query}`]
  if (engine) lines.push(`engine: ${engine}${live === true ? " (live)" : ""}`)
  if (warning) lines.push(`warning: ${warning}`)
  lines.push(`results shown: ${shown.length}/${count ?? results.length}`)
  for (const [index, result] of shown.entries()) {
    lines.push(`[${index + 1}] ${result.title} | ${result.url}`)
    if (result.snippet) lines.push(`snippet: ${shortInline(result.snippet, 180)}`)
  }
  const omitted = Math.max(0, (count ?? results.length) - shown.length)
  if (omitted > 0) lines.push(`+${omitted} more search results omitted from persistent history`)
  return lines.join("\n")
}

function compactWebFetchOutput(part: ToolResultPart, rawOutput: string) {
  const method = stringMetadata(part.metadata, "method") ?? "GET"
  const url = stringMetadata(part.metadata, "url") ?? "unknown url"
  const finalUrl = stringMetadata(part.metadata, "finalUrl")
  const httpStatus = numberMetadata(part.metadata, "httpStatus")
  const contentType = stringMetadata(part.metadata, "contentType")
  const lines = [`Web fetch: ${method} ${url}`]
  if (finalUrl && finalUrl !== url) lines.push(`finalUrl: ${finalUrl}`)
  if (httpStatus !== undefined) lines.push(`status: ${httpStatus}`)
  if (contentType) lines.push(`contentType: ${contentType}`)
  lines.push("excerpt:")
  lines.push(compactExcerpt(rawOutput, { head: 1_100, tail: 700, limit: 2_600 }))
  return lines.join("\n")
}

function compactBashOutput(part: ToolResultPart, rawOutput: string) {
  const command = stringMetadata(part.metadata, "command") ?? "bash"
  const exitCode = numberMetadata(part.metadata, "exitCode")
  const durationMs = numberMetadata(part.metadata, "durationMs")
  const flags = [
    booleanMetadata(part.metadata, "timedOut") ? "timed_out" : "",
    booleanMetadata(part.metadata, "cancelled") ? "cancelled" : "",
    booleanMetadata(part.metadata, "truncated") ? "sandbox_output_truncated" : "",
    booleanMetadata(part.metadata, "sandboxBypassed") ? "sandbox_bypassed" : "",
    booleanMetadata(part.metadata, "pathBoundaryBypassed") ? "path_boundary_bypassed" : "",
  ].filter(Boolean)
  const lines = [
    `command: ${command}`,
    `status: ${part.status}${exitCode !== undefined ? ` (exit=${exitCode})` : ""}${durationMs !== undefined ? `, durationMs=${durationMs}` : ""}`,
  ]
  if (flags.length > 0) lines.push(`flags: ${flags.join(", ")}`)
  const diagnostics = keyDiagnosticLines(rawOutput)
  if (diagnostics.length > 0) {
    lines.push("key lines:")
    for (const line of diagnostics) lines.push(`- ${line}`)
  }
  lines.push("excerpt:")
  lines.push(compactExcerpt(rawOutput, { head: 1_100, tail: 900, limit: 3_200 }))
  return lines.join("\n")
}

function compactReadOutput(part: ToolResultPart, rawOutput: string) {
  const filePath = stringMetadata(part.metadata, "filePath") ?? "unknown"
  const startLine = numberMetadata(part.metadata, "startLine")
  const endLine = numberMetadata(part.metadata, "endLine")
  const lineCount = numberMetadata(part.metadata, "lineCount")
  const lines = [part.toolName === "read_lines" ? `file: ${filePath}:${startLine ?? "?"}-${endLine ?? "?"}` : `file: ${filePath}`]
  if (lineCount !== undefined) lines.push(`lineCount: ${lineCount}`)
  lines.push("excerpt:")
  lines.push(compactExcerpt(rawOutput, { head: 1_100, tail: 900, limit: 3_200 }))
  return lines.join("\n")
}

function compactGitDiffOutput(part: ToolResultPart, rawOutput: string) {
  const mode = stringMetadata(part.metadata, "mode") ?? "summary"
  const filePath = stringMetadata(part.metadata, "filePath")
  const summaryLines = rawOutput.split(/\r?\n/).filter((line) => line.startsWith("@@") || (/^[+-][^+-]/.test(line) && !line.startsWith("+++"))).slice(0, 8)
  const lines = [`git diff mode: ${mode}`]
  if (filePath) lines.push(`path: ${filePath}`)
  if (summaryLines.length > 0) {
    lines.push("key hunks:")
    lines.push(...summaryLines)
  } else {
    lines.push("excerpt:")
    lines.push(compactExcerpt(rawOutput, { head: 1_000, tail: 700, limit: 2_600 }))
  }
  return lines.join("\n")
}

function compactLedgerOutput(_part: ToolResultPart, rawOutput: string) {
  const records = rawOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- "))
  const lines = ["ledger snapshot:"]
  if (records.length === 0) {
    lines.push(rawOutput.trim() || "No context ledger records.")
    return lines.join("\n")
  }
  lines.push(...records.slice(0, 8))
  if (records.length > 8) lines.push(`+${records.length - 8} more ledger records omitted from persistent history`)
  return lines.join("\n")
}

function compactDelegateSubagentOutput(rawOutput: string) {
  return truncateLargeOutput(rawOutput, true, historyToolExcerptLimit)
}

function compactExcerpt(text: string, options: { head: number; tail: number; limit: number }) {
  const trimmed = text.trim()
  if (!trimmed) return "(no output)"
  if (trimmed.length <= options.limit) return trimmed
  const omitted = Math.max(0, trimmed.length - options.head - options.tail)
  return `${trimmed.slice(0, options.head)}\n[history compacted: omitted ${omitted} chars]\n${trimmed.slice(-options.tail)}`
}

function keyDiagnosticLines(text: string) {
  const pattern = /(error|failed|failure|exception|traceback|panic|fatal|denied|invalid|timeout|timed out|not found|permission|refused|assert)/i
  return uniqueStrings(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && pattern.test(line))).slice(0, 6)
}

function shortInline(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 24))}...[omitted ${normalized.length - limit} chars]`
}

function stringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function numberMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanMetadata(metadata: Record<string, unknown>, key: string) {
  return metadata[key] === true ? true : metadata[key] === false ? false : undefined
}

function artifactMetadata(metadata: Record<string, unknown>) {
  const value = metadata.artifacts
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const artifact = item as { kind?: unknown; path?: unknown }
    if (typeof artifact.kind !== "string" || typeof artifact.path !== "string") return []
    return [{ kind: artifact.kind, path: artifact.path }]
  })
}

function webResultMetadata(metadata: Record<string, unknown>, rawOutput: string) {
  const preview = metadata.resultsPreview
  if (Array.isArray(preview)) {
    const parsed = preview.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const result = item as { title?: unknown; url?: unknown; snippet?: unknown }
      if (typeof result.title !== "string" || typeof result.url !== "string") return []
      return [{ title: result.title, url: result.url, snippet: typeof result.snippet === "string" ? result.snippet : "" }]
    })
    if (parsed.length > 0) return parsed
  }
  const pattern = /\[web:\d+\]\s+([^\n]+)\nurl:\s+([^\n]+)(?:\nsource:\s+[^\n]+)?(?:\nretrievedAt:\s+[^\n]+)?\nsnippet:\s+([^\n]+)/g
  const results: Array<{ title: string; url: string; snippet: string }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(rawOutput))) {
    results.push({ title: match[1] ?? "", url: match[2] ?? "", snippet: match[3] ?? "" })
  }
  return results
}

function uniqueStrings(items: string[]) {
  return [...new Set(items)]
}

export function partToText(part: MessagePart, options: MessageTextOptions = {}) {
  if (part.type === "text") return part.text
  if (part.type === "reasoning") return `<reasoning>\n${part.text}\n</reasoning>`
  if (part.type === "image") return `<image source="${imageSourceLabel(part.source)}" />`
  if (part.type === "summary") return `<summary>\n${part.text}\n</summary>`
  if (part.type === "tool_call") return `<tool_call name="${part.call.name}" id="${part.call.id}">${JSON.stringify(part.call.input)}</tool_call>`
  const output = options.redactProtectedToolResults && isProtectedToolResult(part) ? protectedToolResultRedaction : part.output
  return `<tool_result name="${part.toolName}" id="${part.callID}" status="${part.status}">\n${renderToolResultOutputForProvider(part, output, options)}\n</tool_result>`
}

export function messageToText(message: Message, options: MessageTextOptions = {}) {
  return message.parts.map((part) => {
    if (message.role === "assistant" && part.type === "text") return truncateLargeOutput(part.text, options.truncateLargeOutputs, options.largeOutputLimit)
    if (message.role === "assistant" && part.type === "reasoning") return `<reasoning>\n${truncateLargeOutput(part.text, options.truncateLargeOutputs, options.largeOutputLimit)}\n</reasoning>`
    return partToText(part, options)
  }).join("\n")
}

export function messagesToProviderInput(messages: Message[], options: MessageTextOptions = {}): ProviderInputMessage[] {
  messages = normalizeMessages(messages)
  const foldedToolResults = supersededToolResultFolds(messages)
  const renderOptions = foldedToolResults.size > 0 ? { ...options, foldedToolResults } : options
  return messages.map((message) => ({ role: message.role, content: messageToText(message, renderOptions), parts: providerParts(message, renderOptions) }))
}

export function toolResults(messages: Message[]) {
  messages = normalizeMessages(messages)
  return messages.flatMap((message) => message.parts.filter((part): part is ToolResultPart => part.type === "tool_result"))
}

export function toolCalls(messages: Message[]) {
  messages = normalizeMessages(messages)
  return messages.flatMap((message) => message.parts.filter((part): part is ToolCallPart => part.type === "tool_call"))
}

export function toolInvocations(messages: Message[]): ToolInvocation[] {
  messages = normalizeMessages(messages)
  const calls = new Map<string, ToolInvocation>()
  const ordered: ToolInvocation[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const invocation: ToolInvocation = {
          callID: part.call.id,
          toolName: part.call.name,
          input: part.call.input,
          status: "pending",
        }
        calls.set(part.call.id, invocation)
        ordered.push(invocation)
        continue
      }
      if (part.type !== "tool_result") continue
      const invocation = calls.get(part.callID)
      if (!invocation) continue
      invocation.status = part.status
      invocation.output = part.output
      invocation.metadata = part.metadata
    }
  }
  return ordered
}

export function truncateLargeMessageOutputs(messages: Message[]): Message[] {
  return canonicalizeHistoryMessages(messages)
}

function truncateLargeOutput(text: string, enabled = true, limit = largeOutputLimit) {
  if (!enabled || text.length <= limit) return text
  const head = limit === largeOutputLimit ? largeOutputHead : Math.max(0, Math.floor(limit * 0.55))
  const tail = limit === largeOutputLimit ? largeOutputTail : Math.max(0, Math.floor(limit * 0.35))
  const omitted = Math.max(0, text.length - head - tail)
  return `${text.slice(0, head)}\n\n[truncated ${omitted} chars from large historical output]\n\n${text.slice(-tail)}`
}

function providerParts(message: Message, options: MessageTextOptions) {
  return message.parts.map((part): MessagePart => {
    if (part.type === "tool_result") {
      const output = options.redactProtectedToolResults && isProtectedToolResult(part) ? protectedToolResultRedaction : part.output
      return { ...part, output: renderToolResultOutputForProvider(part, output, options) }
    }
    if (message.role === "assistant" && part.type === "text") {
      return { ...part, text: truncateLargeOutput(part.text, options.truncateLargeOutputs, options.largeOutputLimit) }
    }
    if (message.role === "assistant" && part.type === "reasoning") {
      return { ...part, text: truncateLargeOutput(part.text, options.truncateLargeOutputs, options.largeOutputLimit) }
    }
    return part
  })
}

type ToolResultRecord = {
  callID: string
  toolName: string
  status: ToolResultPart["status"]
  input: unknown
  metadata: Record<string, unknown>
  feature?: ToolResultFeature
}

function supersededToolResultFolds(messages: Message[]) {
  const inputsByCallID = new Map<string, unknown>()
  const records: ToolResultRecord[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") inputsByCallID.set(part.call.id, part.call.input)
      if (part.type === "tool_result") {
        const record = { callID: part.callID, toolName: part.toolName, status: part.status, input: inputsByCallID.get(part.callID), metadata: part.metadata }
        records.push({ ...record, feature: toolResultFeature(record) })
      }
    }
  }
  const folded = new Map<string, ToolResultFold>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const fold = records.slice(index + 1).map((later) => toolResultSupersession(later, record)).find((item) => item !== undefined)
    if (fold) folded.set(record.callID, fold)
  }
  return folded
}

function toolResultSupersession(candidate: ToolResultRecord, target: ToolResultRecord): ToolResultFold | undefined {
  if (candidate.status !== "succeeded" || target.status !== "succeeded") return undefined
  if (!candidate.feature || !target.feature) return undefined
  return toolResultFeatureSupersession(candidate.feature, target.feature)
}

type ToolResultFeature =
  | { kind: "file_range"; toolName: "read" | "read_lines"; filePath: string; full: boolean; startLine?: number; endLine?: number }
  | { kind: "git_diff"; mode: "summary" | "files" | "stat" | "file"; filePath?: string; truncated: boolean }
  | { kind: "query"; toolName: string; key: string; limit?: number; depth?: number }
  | { kind: "exact"; toolName: string; key: string }

const queryFoldableTools = new Set(["grep", "rg_search", "find_definition", "find_references", "call_graph", "repo_map"])
const exactInspectionFoldableTools = new Set(["list", "git_status", "git_branch", "git_log", "ledger", "memory_query", "connector_list", "mcp_list_resources", "mcp_read_resource"])

function toolResultFeature(record: Omit<ToolResultRecord, "feature">): ToolResultFeature | undefined {
  return fileReadFeature(record) ?? gitDiffFeature(record) ?? queryInspectionFeature(record) ?? exactInspectionFeature(record)
}

function toolResultFeatureSupersession(candidate: ToolResultFeature, target: ToolResultFeature): ToolResultFold | undefined {
  if (candidate.kind === "file_range" && target.kind === "file_range") return fileRangeFeatureSupersession(candidate, target)
  if (candidate.kind === "git_diff" && target.kind === "git_diff") return gitDiffFeatureSupersession(candidate, target)
  if (candidate.kind === "query" && target.kind === "query") return queryFeatureSupersession(candidate, target)
  if (candidate.kind === "exact" && target.kind === "exact") return exactFeatureSupersession(candidate, target)
  return undefined
}

function fileRangeFeatureSupersession(candidate: Extract<ToolResultFeature, { kind: "file_range" }>, target: Extract<ToolResultFeature, { kind: "file_range" }>): ToolResultFold | undefined {
  if (candidate.filePath !== target.filePath || !fileRangeCovers(candidate, target)) return undefined
  return {
    reason: "file_read_range_superseded",
    retrievalHint: target.full
      ? `use the later full-file read for ${target.filePath}`
      : `use the later read covering ${target.filePath}:${target.startLine}-${target.endLine}`,
  }
}

function gitDiffFeatureSupersession(candidate: Extract<ToolResultFeature, { kind: "git_diff" }>, target: Extract<ToolResultFeature, { kind: "git_diff" }>): ToolResultFold | undefined {
  if (!gitDiffCovers(candidate, target)) return undefined
  return {
    reason: "git_diff_view_superseded",
    retrievalHint: candidate.mode === "file" && candidate.filePath ? `use the later git_diff mode=file for ${candidate.filePath}` : `use the later git_diff mode=${candidate.mode}`,
  }
}

function queryFeatureSupersession(candidate: Extract<ToolResultFeature, { kind: "query" }>, target: Extract<ToolResultFeature, { kind: "query" }>): ToolResultFold | undefined {
  if (candidate.toolName !== target.toolName || candidate.key !== target.key) return undefined
  if (!limitCovers(candidate.limit, target.limit) || !limitCovers(candidate.depth, target.depth)) return undefined
  return {
    reason: "query_result_superseded",
    retrievalHint: `use the later ${candidate.toolName} result for the same query/input`,
  }
}

function exactFeatureSupersession(candidate: Extract<ToolResultFeature, { kind: "exact" }>, target: Extract<ToolResultFeature, { kind: "exact" }>): ToolResultFold | undefined {
  if (candidate.toolName !== target.toolName || candidate.key !== target.key) return undefined
  return {
    reason: "same_inspection_superseded",
    retrievalHint: `use the later ${candidate.toolName} result for the same input`,
  }
}

function fileReadFeature(record: Omit<ToolResultRecord, "feature">): ToolResultFeature | undefined {
  if (record.toolName !== "read" && record.toolName !== "read_lines") return undefined
  const filePath = stringMetadata(record.metadata, "filePath") ?? stringInput(record.input, "filePath")
  if (!filePath) return undefined
  if (record.toolName === "read") return { kind: "file_range", toolName: "read", filePath, full: true }
  const startLine = numberMetadata(record.metadata, "startLine") ?? numberInput(record.input, "startLine")
  const endLine = numberMetadata(record.metadata, "endLine") ?? numberInput(record.input, "endLine")
  if (startLine === undefined || endLine === undefined) return undefined
  return { kind: "file_range", toolName: "read_lines", filePath, full: false, startLine, endLine }
}

function gitDiffFeature(record: Omit<ToolResultRecord, "feature">): ToolResultFeature | undefined {
  if (record.toolName !== "git_diff") return undefined
  const mode = gitDiffMode(stringMetadata(record.metadata, "mode") ?? stringInput(record.input, "mode") ?? "summary")
  if (!mode) return undefined
  const filePath = stringMetadata(record.metadata, "filePath") ?? stringInput(record.input, "filePath")
  if (mode === "file" && !filePath) return undefined
  return { kind: "git_diff", mode, filePath, truncated: booleanMetadata(record.metadata, "truncated") === true }
}

function queryInspectionFeature(record: Omit<ToolResultRecord, "feature">): ToolResultFeature | undefined {
  if (!queryFoldableTools.has(record.toolName) || !isRecord(record.input)) return undefined
  const normalized = queryFeatureInput(record.toolName, record.input)
  if (!normalized) return undefined
  return {
    kind: "query",
    toolName: record.toolName,
    key: stableStringifyFeature(normalized.key),
    limit: normalized.limit,
    depth: normalized.depth,
  }
}

function exactInspectionFeature(record: Omit<ToolResultRecord, "feature">): ToolResultFeature | undefined {
  if (!exactInspectionFoldableTools.has(record.toolName)) return undefined
  return { kind: "exact", toolName: record.toolName, key: stableStringifyFeature(normalizeExactInspectionInput(record.toolName, record.input)) }
}

function fileRangeCovers(candidate: Extract<ToolResultFeature, { kind: "file_range" }>, target: Extract<ToolResultFeature, { kind: "file_range" }>) {
  if (candidate.full) return true
  if (target.full) return false
  if (candidate.startLine === undefined || candidate.endLine === undefined || target.startLine === undefined || target.endLine === undefined) return false
  return candidate.startLine <= target.startLine && candidate.endLine >= target.endLine
}

function gitDiffCovers(candidate: Extract<ToolResultFeature, { kind: "git_diff" }>, target: Extract<ToolResultFeature, { kind: "git_diff" }>) {
  if (candidate.mode === target.mode && candidate.filePath === target.filePath) return true
  if (candidate.mode === "summary" && target.mode !== "file") return true
  if (candidate.mode === "files" && target.mode === "files") return true
  if (candidate.mode === "stat" && target.mode === "stat") return true
  if (candidate.mode === "file" && target.mode === "file") return candidate.filePath === target.filePath && !candidate.truncated
  return false
}

function queryFeatureInput(toolName: string, input: Record<string, unknown>) {
  if (toolName === "grep") return { key: { query: input.query, dir: stringOrDefault(input.dir, ".") } }
  if (toolName === "rg_search") {
    return {
      key: { query: input.query, dir: stringOrDefault(input.dir, "."), fileType: input.fileType },
      limit: finiteNumber(input.maxResults),
    }
  }
  if (toolName === "find_definition" || toolName === "find_references") {
    return {
      key: { symbol: input.symbol, language: input.language },
      limit: finiteNumber(input.maxResults),
    }
  }
  if (toolName === "call_graph") {
    return {
      key: { symbol: input.symbol, direction: input.direction, language: input.language },
      depth: finiteNumber(input.depth),
      limit: finiteNumber(input.maxResults),
    }
  }
  if (toolName === "repo_map") {
    return {
      key: { dir: stringOrDefault(input.dir, "."), language: input.language, query: input.query, useCache: input.useCache },
      limit: finiteNumber(input.maxFiles),
    }
  }
  return undefined
}

function normalizeExactInspectionInput(toolName: string, input: unknown) {
  if (!isRecord(input)) return input
  if (toolName === "list") return { dirPath: stringOrDefault(input.dirPath, ".") }
  return input
}

function limitCovers(candidate: number | undefined, target: number | undefined) {
  if (candidate === undefined || target === undefined) return candidate === target
  return candidate >= target
}

function gitDiffMode(value: string) {
  return value === "summary" || value === "files" || value === "stat" || value === "file" ? value : undefined
}

function stringInput(input: unknown, key: string) {
  return isRecord(input) && typeof input[key] === "string" && input[key].trim() ? input[key].trim() : undefined
}

function numberInput(input: unknown, key: string) {
  return isRecord(input) ? finiteNumber(input[key]) : undefined
}

function stringOrDefault(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stableStringifyFeature(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringifyFeature(item)).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringifyFeature(entryValue)}`).join(",")}}`
}

function imageSourceLabel(source: ImageSource) {
  return source.type === "url" ? source.url : source.path
}

function renderToolResultOutputForProvider(part: ToolResultPart, output: string, options: MessageTextOptions) {
  const fold = options.foldedToolResults?.get(part.callID)
  if (fold) return renderFoldedToolResult(part, fold)
  const budgetChars = toolResultBudgetChars(options.toolResultTokenBudget)
  const truncated = renderEvidenceFirstToolResult(part, output, budgetChars)
  if (part.toolName !== "delegate_subagent") return truncated
  const coordinatorSummary = stringMetadata(part.metadata, "coordinatorSummary")
  if (!coordinatorSummary) return truncated
  return `${truncated}\n<coordinator_summary>\n${coordinatorSummary}\n</coordinator_summary>`
}

function renderFoldedToolResult(part: ToolResultPart, fold: ToolResultFold) {
  const rawLength = numberMetadata(part.metadata, "rawOutputLength")
  const lineCount = numberMetadata(part.metadata, "lineCount")
  return [
    "<evidence>",
    "status: partial",
    `source: ${part.toolName}`,
    ...toolSourceLines(part).map((line) => shortInline(line, 180)),
    ...(lineCount !== undefined ? [`lineCount: ${lineCount}`] : []),
    ...(rawLength !== undefined ? [`rawOutputLength: ${rawLength}`] : []),
    `omitted: ${fold.reason}`,
    `retrievalHint: ${fold.retrievalHint}`,
    "</evidence>",
    "excerpt:",
    "(excerpt omitted because a later tool result supersedes this result)",
  ].join("\n")
}

function renderEvidenceFirstToolResult(part: ToolResultPart, output: string, budgetChars: number) {
  const diagnostics = toolResultDiagnostics(part, output)
  const partial = isPartialToolResult(part, output, budgetChars)
  const hint = retrievalHint(part)
  const omitted = omittedText(part, output, partial)
  const evidenceLines = [
    "<evidence>",
    `status: ${partial ? "partial" : "complete"}`,
    `source: ${part.toolName}`,
    ...toolSourceLines(part).map((line) => shortInline(line, 180)),
  ]
  if (diagnostics.length > 0) {
    evidenceLines.push("diagnostics:")
    for (const line of diagnostics) evidenceLines.push(`- ${shortInline(line, 160)}`)
  }
  if (omitted) evidenceLines.push(`omitted: ${omitted}`)
  if (partial) evidenceLines.push(`retrievalHint: ${hint}`)
  evidenceLines.push("</evidence>", "excerpt:")
  const evidence = evidenceLines.join("\n")
  const remaining = Math.max(0, budgetChars - evidence.length - 1)
  const excerpt = excerptForBudget(output, remaining, partial)
  return `${evidence}\n${excerpt}`.slice(0, Math.max(budgetChars, evidence.length))
}

function toolResultBudgetChars(tokenBudget = defaultToolResultTokenBudget) {
  return normalizedToolResultTokenBudget(tokenBudget) * 4
}

function normalizedToolResultTokenBudget(tokenBudget = defaultToolResultTokenBudget) {
  return Math.max(300, Math.min(4_000, Math.floor(tokenBudget)))
}

function isPartialToolResult(part: ToolResultPart, output: string, budgetChars: number) {
  const rawLength = numberMetadata(part.metadata, "rawOutputLength")
  const missingCoordinatorSummary = part.toolName === "delegate_subagent" && !stringMetadata(part.metadata, "coordinatorSummary")
  return booleanMetadata(part.metadata, "truncated") === true ||
    booleanMetadata(part.metadata, "historyCompacted") === true ||
    missingCoordinatorSummary ||
    (rawLength !== undefined && rawLength > output.length) ||
    output.trim().length > budgetChars ||
    /\[(?:truncated|history compacted):? /i.test(output)
}

function omittedText(part: ToolResultPart, output: string, partial: boolean) {
  if (!partial) return undefined
  const rawLength = numberMetadata(part.metadata, "rawOutputLength")
  if (rawLength !== undefined && rawLength > output.length) return `${rawLength - output.length} chars`
  const stdoutLength = numberMetadata(part.metadata, "stdoutRawLength")
  const stderrLength = numberMetadata(part.metadata, "stderrRawLength")
  const totalRaw = (stdoutLength ?? 0) + (stderrLength ?? 0)
  if (totalRaw > output.length) return `${totalRaw - output.length} chars`
  return "unknown"
}

function toolSourceLines(part: ToolResultPart) {
  if (part.toolName === "bash") {
    const command = stringMetadata(part.metadata, "command")
    const exitCode = numberMetadata(part.metadata, "exitCode")
    return [
      ...(command ? [`command: ${command}`] : []),
      ...(exitCode !== undefined ? [`exitCode: ${exitCode}`] : []),
    ]
  }
  if (part.toolName === "read" || part.toolName === "read_lines") {
    const filePath = stringMetadata(part.metadata, "filePath")
    const startLine = numberMetadata(part.metadata, "startLine")
    const endLine = numberMetadata(part.metadata, "endLine")
    if (!filePath) return []
    return [part.toolName === "read_lines" ? `path: ${filePath}:${startLine ?? "?"}-${endLine ?? "?"}` : `path: ${filePath}`]
  }
  if (part.toolName === "git_diff") {
    const mode = stringMetadata(part.metadata, "mode")
    const filePath = stringMetadata(part.metadata, "filePath")
    return [`mode: ${mode ?? "summary"}`, ...(filePath ? [`path: ${filePath}`] : [])]
  }
  if (part.toolName === "delegate_subagent") {
    const role = stringMetadata(part.metadata, "subagentRole")
    const status = stringMetadata(part.metadata, "subagentStatus")
    return [...(role ? [`role: ${role}`] : []), ...(status ? [`subagentStatus: ${status}`] : [])]
  }
  return []
}

function toolResultDiagnostics(part: ToolResultPart, output: string) {
  return uniqueStrings([
    ...stringArrayMetadata(part.metadata, "stdoutDiagnostics"),
    ...stringArrayMetadata(part.metadata, "stderrDiagnostics"),
    ...keyDiagnosticLines(output),
  ]).slice(0, 5)
}

function retrievalHint(part: ToolResultPart) {
  if (part.toolName === "bash") return "rerun a narrower command or filter logs around the diagnostic lines"
  if (part.toolName === "read") return "use read_lines with a focused line range"
  if (part.toolName === "read_lines") return "request a narrower adjacent line range"
  if (part.toolName === "git_diff") return "use git_diff mode=file with a narrower path"
  if (part.toolName === "delegate_subagent") return "review coordinator_summary first; redelegate with narrower success_criteria if evidence is insufficient"
  return "rerun the tool with a narrower query or source"
}

function excerptForBudget(text: string, budgetChars: number, partial: boolean) {
  const trimmed = text.trim()
  if (!trimmed) return "(no output)"
  if (budgetChars <= 0) return "(excerpt omitted by tool result budget)"
  if (!partial && trimmed.length <= budgetChars) return trimmed
  if (trimmed.length <= budgetChars) return trimmed
  if (budgetChars < 160) return `${trimmed.slice(0, budgetChars)}`
  const marker = "\n[tool result budget excerpt: middle omitted]\n"
  const bodyBudget = Math.max(0, budgetChars - marker.length)
  const head = Math.floor(bodyBudget * 0.55)
  const tail = Math.max(0, bodyBudget - head)
  return `${trimmed.slice(0, head)}${marker}${trimmed.slice(Math.max(0, trimmed.length - tail))}`
}

function stringArrayMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}
