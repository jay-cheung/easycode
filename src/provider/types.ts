
import type { AgentMode, Message, ProviderInputMessage, ToolCall } from "../message"
import type { ToolDef } from "../tool"

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" }

export type ProviderInput = {
  mode: AgentMode
  prompt: string
  messages: Message[]
  providerMessages: ProviderInputMessage[]
  tools: ToolDef[]
}

export interface Provider {
  readonly name: string
  stream(input: ProviderInput): AsyncIterable<ProviderEvent>
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderError"
  }
}