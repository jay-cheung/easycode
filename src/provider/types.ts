
import type { AgentMode, Message, ProviderInputMessage, ToolCall } from "../message"
import type { ReasoningEffort } from "../settings"
import type { ToolDef } from "../tool"

export type ProviderCapabilities = {
  apiStyle: "responses" | "chat_completions" | "text_tool_protocol" | "local"
  supportsImages: boolean
  supportsThinking: boolean
  supportsReasoningEffort: boolean
  effortValues: ReasoningEffort[]
  supportsJsonObjectResponse: boolean
  supportsMaxOutputTokens: boolean
  promptCacheMode: "explicit" | "automatic" | "reported" | "none"
  contextWindowTokens?: number
  promptCacheMinPrefixTokens?: number
}

export const defaultProviderCapabilities: ProviderCapabilities = {
  apiStyle: "local",
  supportsImages: false,
  supportsThinking: false,
  supportsReasoningEffort: false,
  effortValues: [],
  supportsJsonObjectResponse: false,
  supportsMaxOutputTokens: false,
  promptCacheMode: "none",
}

export type ProviderOptions = {
  model?: string
  thinking?: boolean
  effort?: ReasoningEffort
  promptCacheKey?: string
  promptCacheRetention?: "in_memory" | "24h"
  responseFormat?: "json_object"
  maxOutputTokens?: number
}

export type ProviderEvent =
  | { type: "request"; request: { url: string; method: string; body: unknown } }
  | { type: "response"; response: { url: string; status: number; ok: boolean; headers: Record<string, string>; body?: string } }
  | { type: "response_raw"; response: unknown }
  | { type: "failure"; error: { message: string; code?: string; output: string } }
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number; totalTokens?: number; reasoningTokens?: number }
  | { type: "done" }

export type ProviderInput = {
  mode: AgentMode
  prompt: string
  messages: Message[]
  providerMessages: ProviderInputMessage[]
  tools: ToolDef[]
  signal?: AbortSignal
}

export interface Provider {
  readonly name: string
  readonly model?: string
  readonly capabilities?: ProviderCapabilities
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
