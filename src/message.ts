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
  const keptCallIDs = new Set<string>()
  const withMatchedCalls = messages.map((message, index) => {
    if (message.role !== "assistant") return message
    const toolCalls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call")
    if (toolCalls.length === 0) return message
    const followingResultIDs = new Set<string>()
    for (let next = index + 1; next < messages.length && messages[next].role === "tool"; next += 1) {
      for (const part of messages[next].parts) {
        if (part.type === "tool_result") followingResultIDs.add(part.callID)
      }
    }
    const parts = message.parts.filter((part) => part.type !== "tool_call" || followingResultIDs.has(part.call.id))
    for (const part of parts) {
      if (part.type === "tool_call") keptCallIDs.add(part.call.id)
    }
    return { ...message, parts }
  })
  return withMatchedCalls.map((message) => {
    if (message.role !== "tool") return message
    return { ...message, parts: message.parts.filter((part) => part.type !== "tool_result" || keptCallIDs.has(part.callID)) }
  }).filter((message) => message.parts.length > 0)
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
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === "tool_result") return { ...part, output: truncateLargeOutput(part.output, true) }
      if (message.role === "assistant" && part.type === "text") {
        // Preserve full plan output (wrapped in <proposed_plan> tags)
        if (/<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(part.text)) return part
        return { ...part, text: truncateLargeOutput(part.text, true) }
      }
      if (message.role === "assistant" && part.type === "reasoning") return { ...part, text: truncateLargeOutput(part.text, true) }
      return part
    }),
  }))
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
