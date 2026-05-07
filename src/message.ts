export type AgentMode = "build" | "plan"
export type PermissionAction = "deny" | "ask" | "allow"
export type MessageRole = "system" | "user" | "assistant" | "tool"
export type ToolCallStatus = "pending" | "running" | "succeeded" | "failed" | "denied"

export type ToolCall = {
  id: string
  name: string
  input: unknown
}

export type TextPart = { type: "text"; text: string }
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

export type MessagePart = TextPart | SummaryPart | ToolCallPart | ToolResultPart

export type Message = {
  id: string
  role: MessageRole
  parts: MessagePart[]
  createdAt: number
}

export type ProviderInputMessage = {
  role: MessageRole
  content: string
}

let idCounter = 0

export function createID(prefix: string) {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

export function textPart(text: string): TextPart {
  return { type: "text", text }
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

export function partToText(part: MessagePart) {
  if (part.type === "text") return part.text
  if (part.type === "summary") return `<summary>\n${part.text}\n</summary>`
  if (part.type === "tool_call") return `<tool_call name="${part.call.name}" id="${part.call.id}">${JSON.stringify(part.call.input)}</tool_call>`
  return `<tool_result name="${part.toolName}" id="${part.callID}" status="${part.status}">\n${part.output}\n</tool_result>`
}

export function messageToText(message: Message) {
  return message.parts.map(partToText).join("\n")
}

export function messagesToProviderInput(messages: Message[]): ProviderInputMessage[] {
  return messages.map((message) => ({ role: message.role, content: messageToText(message) }))
}

export function toolResults(messages: Message[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is ToolResultPart => part.type === "tool_result"))
}
