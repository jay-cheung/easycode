import { HttpSSEProviderBase } from "./http-sse"
import { ProviderError, type ProviderEvent, type ProviderInput } from "./types"
import type { ProviderCapabilities, ProviderOptions } from "./types"
import type { ToolDef } from "../tool"
import { partToText, type ReasoningPart, type SummaryPart, type TextPart, type ToolCallPart, type ToolResultPart } from "../message"
import { parseProviderToolArguments } from "../tool/utils/arguments"

type ChatCompletionMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; reasoning_content?: string; tool_calls?: ChatCompletionRequestToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

type ChatCompletionRequestToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type ChatCompletionStream = {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: ChatCompletionToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: ChatCompletionUsage | null
  error?: {
    code?: string
    message?: string
    type?: string
  }
}

type ChatCompletionToolCallDelta = {
  index?: number
  id?: string
  type?: "function"
  function?: {
    name?: string
    arguments?: string
  }
}

type ChatCompletionUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

type ChatCompletionStreamToolCallState = {
  id?: string
  name?: string
  arguments: string
}

export type ChatCompletionStreamParseState = {
  toolCalls: Map<number, ChatCompletionStreamToolCallState>
  emittedToolCalls: Set<number>
  reasoningContent: string
  emittedFailure: boolean
}

export type ChatCompletionsLikeProviderOptions = {
  name: string
  model: string
  apiKeyEnv: string
  url: string
  capabilities?: ProviderCapabilities
  runtime?: ProviderOptions
  missingApiKeyMessage?: string
  errorPrefix?: string
  includeUsageStreamOption?: boolean
}

export class ChatCompletionsLikeProvider extends HttpSSEProviderBase<ChatCompletionStreamParseState> {
  private readonly includeUsageStreamOption: boolean

  constructor(options: ChatCompletionsLikeProviderOptions) {
    super({
      ...options,
      capabilities: options.capabilities ?? {
        apiStyle: "chat_completions",
        supportsImages: false,
        supportsThinking: false,
        supportsReasoningEffort: false,
        effortValues: [],
        supportsJsonObjectResponse: true,
        supportsMaxOutputTokens: true,
        promptCacheMode: "reported",
      },
      errorPrefix: options.errorPrefix ?? "Chat Completions API failed",
    })
    this.includeUsageStreamOption = options.includeUsageStreamOption ?? true
  }

  protected override validateInput(input: ProviderInput) {
    if (!this.capabilities.supportsImages && input.providerMessages.some((message) => message.parts?.some((part) => part.type === "image"))) {
      throw new ProviderError(`Provider ${this.name} does not support image input. Use /model openai with a vision-capable model.`)
    }
  }

  protected buildRequestBody(input: ProviderInput): unknown {
    return {
      model: this.model,
      messages: input.providerMessages.flatMap(chatMessagesFromProviderMessage),
      stream: true,
      ...(this.includeUsageStreamOption ? { stream_options: { include_usage: true } } : {}),
      tools: input.tools.map(toolToChatCompletionTool),
      ...(this.runtime.responseFormat ? { response_format: { type: this.runtime.responseFormat } } : {}),
      ...(this.runtime.maxOutputTokens ? { max_tokens: this.runtime.maxOutputTokens } : {}),
      ...this.requestBodyExtensions(input),
    }
  }

  protected requestBodyExtensions(_input: ProviderInput): Record<string, unknown> {
    return {}
  }

  protected createStreamParseState() {
    return createChatCompletionStreamParseState()
  }

  protected eventsFromSSELine(line: string, state: ChatCompletionStreamParseState, includeRaw: boolean) {
    return chatCompletionSSELineToProviderEvents(line, state, includeRaw)
  }
}

export function createChatCompletionStreamParseState(): ChatCompletionStreamParseState {
  return { toolCalls: new Map(), emittedToolCalls: new Set(), reasoningContent: "", emittedFailure: false }
}

export function chatCompletionSSEToProviderEvents(parsed: ChatCompletionStream, state: ChatCompletionStreamParseState = createChatCompletionStreamParseState()): ProviderEvent[] {
  if (parsed.error?.message) {
    if (state.emittedFailure) return []
    state.emittedFailure = true
    return [{ type: "failure", error: { message: parsed.error.message, code: parsed.error.code ?? parsed.error.type, output: JSON.stringify(parsed.error) } }]
  }

  const events: ProviderEvent[] = []
  if (parsed.usage) events.push(usageEvent(parsed.usage))

  for (const choice of parsed.choices ?? []) {
    const delta = choice.delta
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      state.reasoningContent += delta.reasoning_content
      events.push({ type: "reasoning_delta", text: delta.reasoning_content })
    }
    if (typeof delta?.content === "string" && delta.content.length > 0) events.push({ type: "text_delta", text: delta.content })
    for (const toolCallDelta of delta?.tool_calls ?? []) accumulateToolCallDelta(toolCallDelta, state)
    if (choice.finish_reason === "tool_calls") events.push(...flushToolCalls(state))
  }

  return events
}

function chatCompletionSSELineToProviderEvents(line: string, state: ChatCompletionStreamParseState, includeRaw = false): ProviderEvent[] {
  const trimmed = line.trimEnd()
  if (!trimmed.startsWith("data: ")) return []
  const data = trimmed.slice(6).trim()
  if (data === "[DONE]") return flushToolCalls(state)
  const parsed = JSON.parse(data) as ChatCompletionStream
  const events = chatCompletionSSEToProviderEvents(parsed, state)
  return includeRaw ? [{ type: "response_raw", response: parsed } satisfies ProviderEvent, ...events] : events
}

function accumulateToolCallDelta(delta: ChatCompletionToolCallDelta, state: ChatCompletionStreamParseState) {
  const index = delta.index ?? 0
  const current = state.toolCalls.get(index) ?? { arguments: "" }
  current.id = delta.id ?? current.id
  current.name = delta.function?.name ?? current.name
  current.arguments += delta.function?.arguments ?? ""
  state.toolCalls.set(index, current)
}

function flushToolCalls(state: ChatCompletionStreamParseState): ProviderEvent[] {
  const events: ProviderEvent[] = []
  for (const [index, toolCall] of [...state.toolCalls.entries()].sort(([left], [right]) => left - right)) {
    if (state.emittedToolCalls.has(index) || !toolCall.name) continue
    state.emittedToolCalls.add(index)
    const rawArguments = toolCall.arguments || "{}"
    const parsedInput = parseProviderToolArguments(rawArguments, toolCall.name, toolCall.id)
    events.push({
      type: "tool_call",
      call: {
        id: toolCall.id ?? `call_${toolCall.name}`,
        name: toolCall.name,
        input: parsedInput.input,
        rawArguments,
        reasoningContent: state.reasoningContent || undefined,
      },
    })
  }
  return events
}

function usageEvent(usage: ChatCompletionUsage): ProviderEvent {
  const inputTokens = usage.prompt_tokens ?? 0
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
  const cacheMissTokens = usage.prompt_cache_miss_tokens ?? (cacheHitTokens === undefined ? undefined : Math.max(0, inputTokens - cacheHitTokens))
  return {
    type: "usage",
    inputTokens,
    outputTokens: usage.completion_tokens ?? 0,
    cacheHitTokens,
    cacheMissTokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  }
}

export function chatMessagesFromProviderMessage(message: ProviderInput["providerMessages"][number]): ChatCompletionMessage[] {
  const parts = message.parts ?? []
  const toolCalls = parts.filter((part): part is ToolCallPart => part.type === "tool_call")
  if (message.role === "assistant" && toolCalls.length > 0) {
    const text = parts.filter((part): part is TextPart | SummaryPart => part.type === "text" || part.type === "summary").map((part) => partToText(part)).join("\n")
    const reasoningContent = toolCalls.find((part) => part.call.reasoningContent)?.call.reasoningContent ?? parts.filter((part): part is ReasoningPart => part.type === "reasoning").map((part) => part.text).join("")
    return [
      {
        role: "assistant",
        content: text || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        tool_calls: toolCalls.map((part) => ({
          id: part.call.id,
          type: "function",
          function: { name: part.call.name, arguments: part.call.rawArguments ?? JSON.stringify(part.call.input) },
        })),
      },
    ]
  }
  const toolResults = parts.filter((part): part is ToolResultPart => part.type === "tool_result")
  if (message.role === "tool" && toolResults.length > 0) {
    return toolResults.map((part) => ({ role: "tool", tool_call_id: part.callID, content: toolResultContent(part) }))
  }
  const role = message.role === "system" || message.role === "assistant" ? message.role : "user"
  if (role === "assistant") {
    const text = parts.filter((part): part is TextPart | SummaryPart => part.type === "text" || part.type === "summary").map((part) => partToText(part)).join("\n")
    const reasoningContent = parts.filter((part): part is ReasoningPart => part.type === "reasoning").map((part) => part.text).join("")
    return [{ role, content: text || null, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) }]
  }
  return [{ role, content: message.content }]
}

function toolResultContent(part: ToolResultPart) {
  if (part.status === "succeeded") return part.output
  return `status: ${part.status}\n${part.output}`
}

export function toolToChatCompletionTool(tool: ToolDef) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    },
  }
}
