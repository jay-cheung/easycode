
import type { AgentMode, Message, ProviderInputMessage, ToolCall } from "../message"
import type { ToolDef } from "../tool"

export type ProviderEvent =
  | { type: "request"; request: { url: string; method: string; body: unknown } }
  | { type: "response"; response: { url: string; status: number; ok: boolean; headers: Record<string, string>; body?: string } }
  | { type: "response_raw"; response: unknown }
  | { type: "failure"; error: { message: string; code?: string; output: string } }
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
  readonly status?: number
  readonly output?: string

  constructor(message: string, options: { status?: number; output?: string } = {}) {
    super(message)
    this.name = "ProviderError"
    this.status = options.status
    this.output = options.output
  }
}
