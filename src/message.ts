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

export function createID(prefix: string) {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

export function textPart(text: string): TextPart {
  return { type: "text", text }
}

export function reasoningPart(text: string): ReasoningPart {
  return { type: "reasoning", text }
}

export function imagePart(source: ImageSource): ImagePart {
  return { type: "image", source }
}

export function summaryPart(text: string): SummaryPart {
  return { type: "summary", text }
}

export function toolCallPart(call: ToolCall, status: ToolCallStatus = "pending"): ToolCallPart {
  return { type: "tool_call", call, status }
}

export function toolResultPart(input: {
  callID: string
  toolName: string
  status: Exclude<ToolCallStatus, "pending" | "running">
  output: string
  metadata?: Record<string, unknown>
}): ToolResultPart {
  return {
    type: "tool_result",
    callID: input.callID,
    toolName: input.toolName,
    status: input.status,
    output: input.output,
    metadata: input.metadata ?? {},
  }
}

export function createMessage(role: MessageRole, parts: MessagePart[], id = createID("msg")): Message {
  return { id, role, parts, createdAt: Date.now() }
}

export function textMessage(role: MessageRole, text: string, id?: string): Message {
  return createMessage(role, [textPart(text)], id)
}

export function userMessage(text: string, images: ImagePart[] = [], id?: string): Message {
  const parts: MessagePart[] = []
  if (text) parts.push(textPart(text))
  parts.push(...images)
  return createMessage("user", parts, id)
}

export function toolCallMessage(call: ToolCall | ToolCall[]): Message {
  const calls = Array.isArray(call) ? call : [call]
  return createMessage("assistant", calls.map((item) => toolCallPart(item, "pending")))
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
const largeOutputHead = 4_000
const largeOutputTail = 3_000
const historyAssistantTextLimit = 4_000
const historyReasoningTextLimit = 1_500
const historyPlanTextLimit = 3_000
const historyToolExcerptLimit = 2_400
const historyCanonicalVersion = 1
type MessageTextOptions = { redactProtectedToolResults?: boolean; truncateLargeOutputs?: boolean; largeOutputLimit?: number }

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
  const protectedCallIDs = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call" && part.call.name === "read" && protectedReadPath(part.call.input)) protectedCallIDs.add(part.call.id)
    }
  }
  return messages.map((message) => redactProtectedMessage(message, protectedCallIDs))
}

export function validProviderMessageSuffix(messages: Message[]) {
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
  return messages.map((message) => canonicalizeHistoryMessage(message))
}

export function canonicalizeHistoryMessage(message: Message): Message {
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

function compactExcerpt(text: string, options: { head: number; tail: number; limit: number }) {
  const trimmed = text.trim()
  if (!trimmed) return "(no output)"
  if (trimmed.length <= options.limit) return trimmed
  const omitted = Math.max(0, trimmed.length - options.head - options.tail)
  return `${trimmed.slice(0, options.head)}\n[history compacted: omitted ${omitted} chars]\n${trimmed.slice(-options.tail)}`
}

function keyDiagnosticLines(text: string) {
  const pattern = /(error|failed|failure|exception|traceback|fatal|denied|invalid|timeout|timed out|not found|permission|refused)/i
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
  return `<tool_result name="${part.toolName}" id="${part.callID}" status="${part.status}">\n${truncateLargeOutput(output, options.truncateLargeOutputs, options.largeOutputLimit)}\n</tool_result>`
}

export function messageToText(message: Message, options: MessageTextOptions = {}) {
  return message.parts.map((part) => {
    if (message.role === "assistant" && part.type === "text") return truncateLargeOutput(part.text, options.truncateLargeOutputs, options.largeOutputLimit)
    if (message.role === "assistant" && part.type === "reasoning") return `<reasoning>\n${truncateLargeOutput(part.text, options.truncateLargeOutputs, options.largeOutputLimit)}\n</reasoning>`
    return partToText(part, options)
  }).join("\n")
}

export function messagesToProviderInput(messages: Message[], options: MessageTextOptions = {}): ProviderInputMessage[] {
  return messages.map((message) => ({ role: message.role, content: messageToText(message, options), parts: providerParts(message, options) }))
}

export function toolResults(messages: Message[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is ToolResultPart => part.type === "tool_result"))
}

export function toolCalls(messages: Message[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is ToolCallPart => part.type === "tool_call"))
}

export function toolInvocations(messages: Message[]): ToolInvocation[] {
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
      return { ...part, output: truncateLargeOutput(output, options.truncateLargeOutputs, options.largeOutputLimit) }
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

function imageSourceLabel(source: ImageSource) {
  return source.type === "url" ? source.url : source.path
}
