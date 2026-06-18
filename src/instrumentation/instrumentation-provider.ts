import type { ProviderInputMessage, ToolResultPart } from "../message"
import { ProviderError, type ProviderEvent } from "../provider"
import { emitLog, type Logger } from "../logger"
import { estimateTextTokens } from "../context"

export type ProviderUsageLog = {
  inputTokens: number
  outputTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheHit: boolean
}

export function providerInputTokenEstimate(providerMessages: Array<{ content: string }>, tools: unknown[]) {
  const messageTokens = estimateTextTokens(providerMessages.map((message) => message.content).join(""))
  const toolTokens = estimateTextTokens(tools.length > 0 ? JSON.stringify(tools) : "")
  return {
    tokenEstimate: messageTokens + toolTokens,
    messageTokens,
    toolTokens,
    providerMessageCount: providerMessages.length,
    toolCount: tools.length,
  }
}

export function providerToolResultStats(providerMessages: ProviderInputMessage[]) {
  const byTool = new Map<string, {
    tool: string
    count: number
    renderedChars: number
    estimatedTokens: number
    maxRenderedChars: number
    maxEstimatedTokens: number
  }>()
  let count = 0
  let renderedChars = 0
  let estimatedTokens = 0
  let maxRenderedChars = 0
  let maxEstimatedTokens = 0
  let maxTool = ""
  let maxCallID = ""

  for (const message of providerMessages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool_result") continue
      const toolPart = part as ToolResultPart
      const chars = toolPart.output.length
      const tokens = estimateTextTokens(toolPart.output)
      count += 1
      renderedChars += chars
      estimatedTokens += tokens
      if (chars > maxRenderedChars) {
        maxRenderedChars = chars
        maxEstimatedTokens = tokens
        maxTool = toolPart.toolName
        maxCallID = toolPart.callID
      }
      const current = byTool.get(toolPart.toolName) ?? {
        tool: toolPart.toolName,
        count: 0,
        renderedChars: 0,
        estimatedTokens: 0,
        maxRenderedChars: 0,
        maxEstimatedTokens: 0,
      }
      current.count += 1
      current.renderedChars += chars
      current.estimatedTokens += tokens
      if (chars > current.maxRenderedChars) {
        current.maxRenderedChars = chars
        current.maxEstimatedTokens = tokens
      }
      byTool.set(toolPart.toolName, current)
    }
  }

  return {
    toolResultCount: count,
    renderedChars,
    estimatedTokens,
    maxRenderedChars,
    maxEstimatedTokens,
    maxTool,
    maxCallID,
    byTool: [...byTool.values()].sort((a, b) => b.estimatedTokens - a.estimatedTokens || b.count - a.count || a.tool.localeCompare(b.tool)),
  }
}

export function providerUsageLog(event: Extract<ProviderEvent, { type: "usage" }>): ProviderUsageLog {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheHitTokens: event.cacheHitTokens,
    cacheMissTokens: event.cacheMissTokens,
    totalTokens: event.totalTokens,
    reasoningTokens: event.reasoningTokens,
    cacheHit: (event.cacheHitTokens ?? 0) > 0,
  }
}

export function logProviderEvent(logger: Logger, event: ProviderEvent, inputText = "") {
  if (event.type === "response" && !event.response.ok) emitLog(logger, { type: "provider", name: "provider.response", detail: { body: event.response.body ?? "" } })
  if (event.type === "response_raw" && rawProviderResponseHasError(event.response)) emitLog(logger, { type: "provider", name: "provider.response.raw", detail: { response: event.response } })
  if (event.type === "failure") {
    emitLog(logger, { type: "provider", name: "provider.failure", detail: event.error })
    emitLog(logger, { type: "error", name: "provider.error", detail: event.error })
  }
  if (event.type === "tool_call") emitLog(logger, { type: "provider", name: "provider.tool_call", detail: { tool: event.call.name, callID: event.call.id } })
  if (event.type === "usage") {
    const usage = providerUsageLog(event)
    const cached = cachedInputMark(inputText, usage.cacheHitTokens)
    emitLog(logger, {
      type: "provider",
      name: "provider.usage",
      detail: {
        ...usage,
        cachedInput: cached.cachedInput,
        uncachedInput: cached.uncachedInput,
        markedInput: cached.markedInput,
      },
    })
  }
  if (event.type === "done") emitLog(logger, { type: "provider", name: "provider.done" })
}

export function emitProviderTranscript(logger: Logger, input: {
  provider: string
  model?: string
  prompt: string
  input: string
  output: string
  reasoningContent: string
  toolCalls: Array<{ tool: string; callID: string }>
  usage?: ProviderUsageLog
  error?: Record<string, unknown>
}) {
  const cached = cachedInputMark(input.input, input.usage?.cacheHitTokens)
  emitLog(logger, {
    type: "provider",
    name: "provider.transcript",
    detail: {
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      input: input.input,
      output: input.output,
      reasoningContent: input.reasoningContent,
      toolCalls: input.toolCalls,
      usage: input.usage,
      cacheHit: input.usage?.cacheHit ?? false,
      cachedInput: cached.cachedInput,
      uncachedInput: cached.uncachedInput,
      markedInput: cached.markedInput,
      ...(input.error ? { error: input.error } : {}),
    },
  })
}

export function renderProviderInput(messages: ProviderInputMessage[]) {
  return messages.map((message, index) => `<message index="${index}" role="${message.role}">\n${message.content}\n</message>`).join("\n\n")
}

export function cachedInputMark(input: string, cacheHitTokens = 0) {
  if (cacheHitTokens <= 0) {
    return {
      cacheHit: false,
      cachedInput: "",
      uncachedInput: input,
      markedInput: `<cache_miss_input>\n${input}\n</cache_miss_input>`,
    }
  }
  const splitIndex = cachedPrefixIndex(input, cacheHitTokens)
  const cachedInput = input.slice(0, splitIndex)
  const uncachedInput = input.slice(splitIndex)
  return {
    cacheHit: true,
    cachedInput,
    uncachedInput,
    markedInput: `<cached_input cache_hit="true" tokens="${cacheHitTokens}">\n${cachedInput}\n</cached_input>\n<cache_miss_input>\n${uncachedInput}\n</cache_miss_input>`,
  }
}

export function rawProviderResponseHasError(response: unknown) {
  if (!response || typeof response !== "object") return false
  const record = response as { type?: unknown; error?: unknown; response?: unknown }
  if (record.type === "error" || record.type === "response.failed") return true
  if (record.error) return true
  if (record.response && typeof record.response === "object" && (record.response as { error?: unknown }).error) return true
  return false
}

export function providerErrorDetail(provider: string, error: unknown) {
  if (error instanceof ProviderError) {
    return {
      provider,
      error: error.name,
      status: error.status,
      message: error.message,
      output: error.output,
    }
  }
  return {
    provider,
    error: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  }
}

function cachedPrefixIndex(input: string, cacheHitTokens: number) {
  let tokens = 0
  let index = 0
  for (const char of input) {
    tokens += estimatedCharTokens(char)
    index += char.length
    if (Math.ceil(tokens) >= cacheHitTokens) return index
  }
  return input.length
}

function estimatedCharTokens(char: string) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char) ? 0.6 : 0.3
}
