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

export function toolCallMessage(call: ToolCall): Message {
  return createMessage("assistant", [toolCallPart(call, "pending")])
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
  return messages.slice(start)
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

export function partToText(part: MessagePart, options: { redactProtectedToolResults?: boolean; truncateLargeOutputs?: boolean } = {}) {
  if (part.type === "text") return part.text
  if (part.type === "reasoning") return `<reasoning>\n${part.text}\n</reasoning>`
  if (part.type === "image") return `<image source="${imageSourceLabel(part.source)}" />`
  if (part.type === "summary") return `<summary>\n${part.text}\n</summary>`
  if (part.type === "tool_call") return `<tool_call name="${part.call.name}" id="${part.call.id}">${JSON.stringify(part.call.input)}</tool_call>`
  const output = options.redactProtectedToolResults && isProtectedToolResult(part) ? protectedToolResultRedaction : part.output
  return `<tool_result name="${part.toolName}" id="${part.callID}" status="${part.status}">\n${truncateLargeOutput(output, options.truncateLargeOutputs)}\n</tool_result>`
}

export function messageToText(message: Message, options: { redactProtectedToolResults?: boolean; truncateLargeOutputs?: boolean } = {}) {
  return message.parts.map((part) => {
    if (message.role === "assistant" && part.type === "text") return truncateLargeOutput(part.text, options.truncateLargeOutputs)
    return partToText(part, options)
  }).join("\n")
}

export function messagesToProviderInput(messages: Message[], options: { redactProtectedToolResults?: boolean; truncateLargeOutputs?: boolean } = {}): ProviderInputMessage[] {
  return messages.map((message) => ({ role: message.role, content: messageToText(message, options), parts: message.parts }))
}

export function toolResults(messages: Message[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is ToolResultPart => part.type === "tool_result"))
}

export function truncateLargeMessageOutputs(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === "tool_result") return { ...part, output: truncateLargeOutput(part.output, true) }
      if (message.role === "assistant" && part.type === "text") return { ...part, text: truncateLargeOutput(part.text, true) }
      if (message.role === "assistant" && part.type === "reasoning") return { ...part, text: truncateLargeOutput(part.text, true) }
      return part
    }),
  }))
}

function truncateLargeOutput(text: string, enabled = true) {
  if (!enabled || text.length <= largeOutputLimit) return text
  const omitted = text.length - largeOutputHead - largeOutputTail
  return `${text.slice(0, largeOutputHead)}\n\n[truncated ${omitted} chars from large historical output]\n\n${text.slice(-largeOutputTail)}`
}

function imageSourceLabel(source: ImageSource) {
  return source.type === "url" ? source.url : source.path
}
