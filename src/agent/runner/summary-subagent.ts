import { estimateTextTokens, type ContextCompactionSnapshot, type ContextManagerLike } from "../../context"
import { extractCompactSummary } from "../../context/prompt"
import type { Provider } from "../../provider"
import type { RunUiEvent } from "../../ui/timeline"
import { finalizeProviderMetrics, type ProviderMetricsAccumulator } from "../metrics"
import type { SubagentRoute } from "../subagent-routing"
import type { Agent } from "../types"

export type BackgroundAgentTask = {
  kind: "summary"
  id: number
  startedAt: number
  agent: Agent
  route: SubagentRoute
  provider: Provider
  snapshot: ContextCompactionSnapshot
  promise: Promise<void>
}

type SummarySubagentDeps = {
  context: ContextManagerLike
  onEvent?: (event: RunUiEvent) => void
  onBackgroundContextUpdate?: () => void | Promise<void>
  activeHypothesisSummary?: string
  compactPrompt: (messages: Array<{ role: string; content: string }>, options?: {
    tokenBudget?: number
    preferredLanguage?: string
    activeHypothesis?: string
    currentUserRequest?: string
    currentUserInput?: string
    activeCapabilitySurface?: string
  }) => string
  summaryLanguageHint: (context: ContextManagerLike, messages: Array<{ role: string; content: string }>) => string | undefined
  ledgerValue: (context: ContextManagerLike, subject: string) => string | undefined
  runProviderTurn: (input: {
    agent: Agent
    prompt: string
    messages: []
    providerMessages: Array<{ role: "system" | "user"; content: string }>
    tools: []
    provider: Provider
    providerMetrics?: ProviderMetricsAccumulator
    emitDeltas?: boolean
    emitProgressEvents?: boolean
    observeContextUsage?: boolean
  }) => Promise<{ text: string; failureText?: string }>
}

export function createSummaryTask(
  id: number,
  agent: Agent,
  route: SubagentRoute,
  provider: Provider,
  snapshot: ContextCompactionSnapshot,
): BackgroundAgentTask {
  return {
    kind: "summary",
    id,
    startedAt: Date.now(),
    agent,
    route,
    provider,
    snapshot,
    promise: Promise.resolve(),
  }
}

export async function runSummarySubagentTask(
  deps: SummarySubagentDeps,
  task: BackgroundAgentTask,
  providerMetrics?: ProviderMetricsAccumulator,
) {
  const finalizedMetrics = () => providerMetrics && providerMetrics.calls > 0 ? finalizeProviderMetrics(providerMetrics) : undefined
  const providerMessages = [
    { role: "system" as const, content: `${task.agent.systemPrompt}\n\nMode: ${task.agent.mode}\nTools: none` },
    {
      role: "user" as const,
      content: deps.compactPrompt(task.snapshot.providerMessages, {
        tokenBudget: deps.context.strategyState.dynamicSummaryTokenBudget,
        preferredLanguage: deps.summaryLanguageHint(deps.context, task.snapshot.providerMessages),
        activeHypothesis: deps.activeHypothesisSummary,
        currentUserRequest: deps.ledgerValue(deps.context, "current_user_request"),
        currentUserInput: deps.ledgerValue(deps.context, "current_user_input"),
        activeCapabilitySurface: deps.ledgerValue(deps.context, "active_capability_surface"),
      }),
    },
  ]
  try {
    if (task.route.maxProviderCalls < 1) throw new Error(`Subagent ${task.route.role} has invalid maxProviderCalls=${task.route.maxProviderCalls}`)
    const turn = await deps.runProviderTurn({
      agent: task.agent,
      prompt: "Summarize conversation for context compaction",
      messages: [],
      providerMessages,
      tools: [],
      provider: task.provider,
      providerMetrics,
      emitDeltas: false,
      emitProgressEvents: false,
      observeContextUsage: false,
    })
    const logicalProviderCalls = providerMetrics ? providerMetrics.calls - providerMetrics.providerRetries : 0
    if (providerMetrics && logicalProviderCalls > task.route.maxProviderCalls) {
      throw new Error(`Subagent ${task.route.role} exceeded provider call budget: ${logicalProviderCalls}/${task.route.maxProviderCalls}`)
    }
    if (turn.failureText) throw new Error(turn.failureText)
    const extracted = extractCompactSummary(turn.text)
    const compacted = deps.context.compactSnapshot(extracted, task.snapshot)
    const metrics = finalizedMetrics()
    if (metrics) deps.onEvent?.({ type: "provider_metrics", metrics })
    deps.onEvent?.({
      type: "subagent",
      status: "completed",
      info: {
        id: task.id,
        role: task.route.role,
        provider: task.route.provider,
        model: task.route.model,
        thinking: task.route.thinking,
        effort: task.route.effort,
        maxProviderCalls: task.route.maxProviderCalls,
        maxOutputTokens: task.route.maxOutputTokens,
      },
      elapsedMs: Date.now() - task.startedAt,
      metrics,
    })
    if (compacted) {
      const storedSummary = deps.context.state.summary ?? extracted
      await deps.onBackgroundContextUpdate?.()
      deps.onEvent?.({
        type: "context_compaction",
        status: "completed",
        elapsedMs: Date.now() - task.startedAt,
        summaryChars: storedSummary.length,
        summaryTokens: estimateTextTokens(storedSummary),
      })
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error)
    const metrics = finalizedMetrics()
    if (metrics) deps.onEvent?.({ type: "provider_metrics", metrics })
    deps.onEvent?.({
      type: "subagent",
      status: "failed",
      info: {
        id: task.id,
        role: task.route.role,
        provider: task.route.provider,
        model: task.route.model,
        thinking: task.route.thinking,
        effort: task.route.effort,
        maxProviderCalls: task.route.maxProviderCalls,
        maxOutputTokens: task.route.maxOutputTokens,
      },
      elapsedMs: Date.now() - task.startedAt,
      error: errorText,
      metrics,
    })
    const fallbackSummary = fallbackCompactSummary(task.snapshot, errorText)
    const compacted = deps.context.compactSnapshot(fallbackSummary, task.snapshot)
    if (!compacted) {
      deps.onEvent?.({ type: "context_compaction", status: "failed", elapsedMs: Date.now() - task.startedAt, error: errorText })
      return
    }
    const storedSummary = deps.context.state.summary ?? fallbackSummary
    await deps.onBackgroundContextUpdate?.()
    deps.onEvent?.({
      type: "context_compaction",
      status: "completed",
      elapsedMs: Date.now() - task.startedAt,
      summaryChars: storedSummary.length,
      summaryTokens: estimateTextTokens(storedSummary),
      error: `provider summary failed; used fallback: ${errorText}`,
    })
  }
}

const fallbackPreviousSummaryChars = 4_000
const fallbackTranscriptMessages = 8
const fallbackMessageChars = 700

function fallbackCompactSummary(snapshot: ContextCompactionSnapshot, errorText: string) {
  const sections = [
    "Fallback context summary generated locally because provider compaction failed.",
    `Compaction error: ${errorText}`,
  ]
  if (snapshot.previousSummary) {
    sections.push(`Previous summary:\n${compactFallbackText(snapshot.previousSummary, fallbackPreviousSummaryChars)}`)
  }
  const transcript = snapshot.providerMessages.slice(-fallbackTranscriptMessages)
    .map((message) => `${message.role}: ${compactFallbackText(message.content, fallbackMessageChars)}`)
    .join("\n\n")
    .trim()
  if (transcript) {
    sections.push([
      "Recent compacted transcript excerpt (bounded; older raw transcript omitted):",
      transcript,
    ].join("\n"))
  }
  return sections.join("\n\n")
}

function compactFallbackText(text: string, limit: number) {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const head = Math.max(0, Math.floor(limit * 0.65))
  const tail = Math.max(0, limit - head)
  return `${trimmed.slice(0, head)}\n[compaction fallback omitted ${trimmed.length - limit} chars]\n${trimmed.slice(-tail)}`
}
