import { OpenAILikeProvider, normalizeModelName } from "./openai-like"
import { ProviderError, type ProviderEvent, type ProviderInput } from "./types"
import type { ProviderOptions } from "./types"
import { toolToResponseTool } from "./utils"
import { partToText, type ReasoningPart, type TextPart, type SummaryPart, type ToolCallPart, type ToolResultPart } from "../message"
import { parseProviderToolArguments } from "../tool/utils/arguments"

type DeepSeekMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; reasoning_content?: string; tool_calls?: DeepSeekRequestToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

type DeepSeekRequestToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type DeepSeekChatCompletionStream = {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: DeepSeekToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: DeepSeekUsage | null
  error?: {
    code?: string
    message?: string
    type?: string
  }
}

type DeepSeekToolCallDelta = {
  index?: number
  id?: string
  type?: "function"
  function?: {
    name?: string
    arguments?: string
  }
}

type DeepSeekUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

type DeepSeekStreamToolCallState = {
  id?: string
  name?: string
  arguments: string
}

type DeepSeekStreamParseState = {
  toolCalls: Map<number, DeepSeekStreamToolCallState>
  emittedToolCalls: Set<number>
  reasoningContent: string
  emittedFailure: boolean
}

export class DeepSeekProvider extends OpenAILikeProvider {
  constructor(model = process.env.DEEPSEEK_MODEL ?? process.env.EASYCODE_MODEL ?? "deepseek-v4-pro", runtime: ProviderOptions = {}) {
    super({
      name: "deepseek",
      model: normalizeModelName(model),
      apiKeyEnv: "DEEPSEEK_API_KEY",
      url: process.env.DEEPSEEK_API_URL ?? "https://api.deepseek.com/chat/completions",
      runtime,
      capabilities: { supportsImages: false, supportsThinking: true, supportsReasoningEffort: true, effortValues: ["high", "max"], contextWindowTokens: numberFromEnv("DEEPSEEK_CONTEXT_WINDOW_TOKENS") ?? numberFromEnv("EASYCODE_CONTEXT_WINDOW_TOKENS"), promptCacheMinPrefixTokens: numberFromEnv("DEEPSEEK_PROMPT_CACHE_MIN_PREFIX_TOKENS") ?? numberFromEnv("EASYCODE_PROMPT_CACHE_MIN_PREFIX_TOKENS") },
      missingApiKeyMessage: "DEEPSEEK_API_KEY is required for DeepSeekProvider",
      errorPrefix: "DeepSeek API failed",
    })
  }

  override async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    if (input.providerMessages.some((message) => message.parts?.some((part) => part.type === "image"))) {
      throw new ProviderError("Provider deepseek does not support image input. Use /model openai with a vision-capable model.")
    }
    yield* super.stream(input)
  }

  protected override buildRequestBody(input: ProviderInput) {
    const thinkingEnabled = this.runtime.thinking !== false
    return {
      model: this.model,
      messages: input.providerMessages.flatMap(chatMessagesFromProviderMessage),
      thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
      ...(thinkingEnabled ? { reasoning_effort: deepSeekReasoningEffort(this.runtime.effort ?? (process.env.DEEPSEEK_REASONING_EFFORT === "high" ? "high" : "max")) } : {}),
      stream: true,
      stream_options: { include_usage: true },
      tools: input.tools.map(toolToChatCompletionTool),
      ...(this.runtime.responseFormat ? { response_format: { type: this.runtime.responseFormat } } : {}),
      ...(this.runtime.maxOutputTokens ? { max_tokens: this.runtime.maxOutputTokens } : {}),
    }
  }

  protected override async *readResponseEvents(response: Response): AsyncIterable<ProviderEvent> {
    if (!response.body) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createDeepSeekStreamParseState()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) yield* deepSeekSSELineToProviderEvents(line, state, true)
    }
    if (buffer) yield* deepSeekSSELineToProviderEvents(buffer, state, true)
  }
}

function numberFromEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

export function createDeepSeekStreamParseState(): DeepSeekStreamParseState {
  return { toolCalls: new Map(), emittedToolCalls: new Set(), reasoningContent: "", emittedFailure: false }
}

export function chatCompletionSSEToProviderEvents(parsed: DeepSeekChatCompletionStream, state: DeepSeekStreamParseState = createDeepSeekStreamParseState()): ProviderEvent[] {
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

function deepSeekSSELineToProviderEvents(line: string, state: DeepSeekStreamParseState, includeRaw = false): ProviderEvent[] {
  const trimmed = line.trimEnd()
  if (!trimmed.startsWith("data: ")) return []
  const data = trimmed.slice(6).trim()
  if (data === "[DONE]") return flushToolCalls(state)
  const parsed = JSON.parse(data) as DeepSeekChatCompletionStream
  const events = chatCompletionSSEToProviderEvents(parsed, state)
  return includeRaw ? [{ type: "response_raw", response: parsed } satisfies ProviderEvent, ...events] : events
}

function accumulateToolCallDelta(delta: DeepSeekToolCallDelta, state: DeepSeekStreamParseState) {
  const index = delta.index ?? 0
  const current = state.toolCalls.get(index) ?? { arguments: "" }
  current.id = delta.id ?? current.id
  current.name = delta.function?.name ?? current.name
  current.arguments += delta.function?.arguments ?? ""
  state.toolCalls.set(index, current)
}

function flushToolCalls(state: DeepSeekStreamParseState): ProviderEvent[] {
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

function usageEvent(usage: DeepSeekUsage): ProviderEvent {
  return {
    type: "usage",
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheHitTokens: usage.prompt_cache_hit_tokens,
    cacheMissTokens: usage.prompt_cache_miss_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  }
}

function chatMessagesFromProviderMessage(message: ProviderInput["providerMessages"][number]): DeepSeekMessage[] {
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

function toolToChatCompletionTool(tool: Parameters<typeof toolToResponseTool>[0]) {
  const responseTool = toolToResponseTool(tool)
  return {
    type: "function",
    function: {
      name: responseTool.name,
      description: responseTool.description,
      parameters: responseTool.parameters,
      strict: responseTool.strict,
    },
  }
}

function deepSeekReasoningEffort(effort: string) {
  return effort === "max" ? "max" : "high"
}
