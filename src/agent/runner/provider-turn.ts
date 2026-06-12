import type { ContextUsageObservation } from "../../context/types"
import { ProviderError, StreamXmlFilter, textToolProtocolOutputToProviderEvents, type Provider } from "../../provider"
import type { ToolDef } from "../../tool"
import type { ToolCall, Message, ProviderInputMessage } from "../../message"
import type { RunUiEvent } from "../../ui/timeline"
import type { Agent } from "../types"
import { finalizeProviderMetrics, finishProviderMetricCall, observeProviderMetricEvent, startProviderMetricCall, type ProviderMetricsAccumulator } from "../metrics"

export type ProviderTurnResult = {
  text: string
  reasoningText: string
  toolCalls: ToolCall[]
  failureText?: string
  cancelledOutput?: string
  replayEvents: Array<
    | { type: "reasoning_delta"; text: string }
    | { type: "text_delta"; text: string }
    | { type: "tool_call"; call: ToolCall }
    | { type: "failure"; text: string }
  >
}

export type ProviderTurnInput = {
  agent: Agent
  prompt: string
  messages: Message[]
  providerMessages: ProviderInputMessage[]
  tools: ToolDef[]
  provider?: Provider
  signal?: AbortSignal
  providerMetrics?: ProviderMetricsAccumulator
  emitDeltas?: boolean
  emitProgressEvents?: boolean
  observeContextUsage?: boolean
}

type ProviderTurnDeps = {
  provider: Provider
  providerProgressIntervalMs: number
  onEvent?: (event: RunUiEvent) => void
  onTextDelta?: (text: string) => void
  onUsage?: (event: ContextUsageObservation) => void
}

export async function runProviderTurnStream(
  deps: ProviderTurnDeps,
  input: ProviderTurnInput,
  failureFormatter: (text: string) => string,
) : Promise<ProviderTurnResult> {
  const textChunks: string[] = []
  const reasoningChunks: string[] = []
  const toolCalls: ToolCall[] = []
  const replayEvents: ProviderTurnResult["replayEvents"] = []
  const tools = input.agent.tools === "none" ? [] : input.tools
  const emitDeltas = input.emitDeltas ?? true
  const emitProgressEvents = input.emitProgressEvents ?? true
  const observeContextUsage = input.observeContextUsage ?? true
  let failureText: string | undefined
  const startedAt = Date.now()
  let currentPhase: "waiting" | "thinking" | "answering" = "waiting"
  const stopProviderProgress = startProviderProgressTimer(deps, input, startedAt, () => currentPhase, emitProgressEvents)
  const metricCall = startProviderMetricCall(input.providerMetrics)
  if (emitProgressEvents && input.providerMetrics && deps.onEvent) {
    deps.onEvent({ type: "provider_metrics", metrics: finalizeProviderMetrics(input.providerMetrics), interim: true })
  }
  const currentText = () => textChunks.join("")
  const currentReasoning = () => reasoningChunks.join("")
  const xmlFilter = new StreamXmlFilter()
  try {
    for await (const event of deps.provider.stream({ mode: input.agent.mode, prompt: input.prompt, messages: input.messages, providerMessages: input.providerMessages, tools, signal: input.signal })) {
      observeProviderMetricEvent(input.providerMetrics, metricCall, event)
      if (emitProgressEvents && event.type === "usage" && input.providerMetrics && deps.onEvent) {
        deps.onEvent({ type: "provider_metrics", metrics: finalizeProviderMetrics(input.providerMetrics), interim: true })
      }
      if (input.signal?.aborted) return { text: currentText(), reasoningText: currentReasoning(), toolCalls, cancelledOutput: appendOutput(currentText(), "Run cancelled by user."), replayEvents }
      if (event.type === "reasoning_delta") {
        stopProviderProgress()
        if (currentPhase === "waiting") {
          currentPhase = "thinking"
          if (emitProgressEvents) deps.onEvent?.({ type: "provider_progress", provider: deps.provider.name, model: deps.provider.model, elapsedMs: Date.now() - startedAt, phase: currentPhase })
        }
        reasoningChunks.push(event.text)
        replayEvents.push({ type: "reasoning_delta", text: event.text })
        if (emitDeltas) {
          deps.onEvent?.({ type: "reasoning_delta", text: event.text })
          deps.onTextDelta?.(event.text)
        }
      }
      if (event.type === "text_delta") {
        stopProviderProgress()
        if (currentPhase !== "answering") {
          currentPhase = "answering"
          if (emitProgressEvents) deps.onEvent?.({ type: "provider_progress", provider: deps.provider.name, model: deps.provider.model, elapsedMs: Date.now() - startedAt, phase: currentPhase })
        }
        textChunks.push(event.text)
        replayEvents.push({ type: "text_delta", text: event.text })
        if (emitDeltas) {
          const safeText = xmlFilter.feed(event.text)
          if (safeText) {
            deps.onEvent?.({ type: "text_delta", text: safeText })
            deps.onTextDelta?.(safeText)
          }
        }
      }
      if (event.type === "failure") {
        stopProviderProgress()
        failureText = failureFormatter(event.error.output || event.error.message)
        replayEvents.push({ type: "failure", text: failureText })
        if (emitDeltas) {
          deps.onEvent?.({ type: "failure", text: failureText })
          deps.onTextDelta?.(failureText)
        }
      }
      if (event.type === "tool_call") {
        stopProviderProgress()
        toolCalls.push(event.call)
        replayEvents.push({ type: "tool_call", call: event.call })
        if (emitDeltas) deps.onEvent?.({ type: "tool_call", call: event.call })
      }
      if (event.type === "usage" && observeContextUsage) deps.onUsage?.(event)
    }
    const leftover = xmlFilter.flush()
    if (emitDeltas && leftover) {
      deps.onEvent?.({ type: "text_delta", text: leftover })
      deps.onTextDelta?.(leftover)
    }
    if (leftover) replayEvents.push({ type: "text_delta", text: leftover })
    return extractFallbackToolCalls({ text: currentText(), reasoningText: currentReasoning(), toolCalls, failureText, replayEvents }, emitDeltas, deps)
  } catch (error) {
    if (input.signal?.aborted) return { text: currentText(), reasoningText: currentReasoning(), toolCalls, cancelledOutput: appendOutput(currentText(), "Run cancelled by user."), replayEvents }
    if (!(error instanceof ProviderError)) throw error
    const formattedFailure = failureFormatter(providerFailureText(error))
    replayEvents.push({ type: "failure", text: formattedFailure })
    if (emitDeltas) deps.onEvent?.({ type: "failure", text: formattedFailure })
    return { text: currentText(), reasoningText: currentReasoning(), toolCalls, failureText: formattedFailure, replayEvents }
  } finally {
    finishProviderMetricCall(input.providerMetrics, metricCall)
    stopProviderProgress()
    if (emitProgressEvents && input.providerMetrics && deps.onEvent) {
      deps.onEvent({ type: "provider_metrics", metrics: finalizeProviderMetrics(input.providerMetrics), interim: true })
    }
  }
}

export function emitProviderTurnEvents(turn: ProviderTurnResult, handlers: Pick<ProviderTurnDeps, "onEvent" | "onTextDelta">) {
  for (const event of turn.replayEvents) {
    if (event.type === "reasoning_delta") {
      handlers.onEvent?.({ type: "reasoning_delta", text: event.text })
      handlers.onTextDelta?.(event.text)
      continue
    }
    if (event.type === "text_delta") {
      handlers.onEvent?.({ type: "text_delta", text: event.text })
      handlers.onTextDelta?.(event.text)
      continue
    }
    if (event.type === "tool_call") {
      handlers.onEvent?.({ type: "tool_call", call: event.call })
      continue
    }
    handlers.onEvent?.({ type: "failure", text: event.text })
    handlers.onTextDelta?.(event.text)
  }
}

function extractFallbackToolCalls(result: ProviderTurnResult, emitDeltas: boolean, deps: Pick<ProviderTurnDeps, "onEvent">): ProviderTurnResult {
  if (result.toolCalls.length > 0 || !result.text || result.failureText || result.cancelledOutput) return result
  const events = textToolProtocolOutputToProviderEvents(result.text)
  const extractedCalls = events.filter((e): e is { type: "tool_call"; call: ToolCall } => e.type === "tool_call").map((e) => e.call)
  if (extractedCalls.length === 0) return result
  const textParts = events.filter((e): e is { type: "text_delta"; text: string } => e.type === "text_delta").map((e) => e.text)
  const replayEvents: ProviderTurnResult["replayEvents"] = [...result.replayEvents.filter((event) => event.type === "reasoning_delta")]
  for (const event of events) {
    if (event.type === "text_delta") replayEvents.push({ type: "text_delta", text: event.text })
    if (event.type === "tool_call") replayEvents.push({ type: "tool_call", call: event.call })
  }
  if (emitDeltas) {
    for (const call of extractedCalls) deps.onEvent?.({ type: "tool_call", call })
  }
  return { ...result, text: textParts.join(""), toolCalls: extractedCalls, replayEvents }
}

function startProviderProgressTimer(
  deps: Pick<ProviderTurnDeps, "onEvent" | "providerProgressIntervalMs" | "provider">,
  input: ProviderTurnInput,
  startedAt: number,
  getPhase: () => "waiting" | "thinking" | "answering",
  emitProgressEvents: boolean,
) {
  if (!emitProgressEvents || !deps.onEvent || deps.providerProgressIntervalMs <= 0) return () => {}
  let stopped = false
  deps.onEvent({ type: "provider_progress", provider: deps.provider.name, model: deps.provider.model, elapsedMs: 0, phase: getPhase() })
  const timer = setInterval(() => {
    if (stopped) return
    deps.onEvent?.({ type: "provider_progress", provider: deps.provider.name, model: deps.provider.model, elapsedMs: Date.now() - startedAt, phase: getPhase() })
  }, deps.providerProgressIntervalMs)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

function providerFailureText(error: ProviderError) {
  return error.output?.trim() || error.message
}

function appendOutput(output: string, part: string) {
  if (!part) return output
  if (!output || output.endsWith("\n")) return `${output}${part}`
  return `${output}\n${part}`
}
