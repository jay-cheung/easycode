import { estimateTextTokens, type ContextCompactionSnapshot, type ContextManagerLike } from "../context"
import { extractCompactSummary } from "../context/prompt"
import type { RunUiEvent } from "../ui/timeline"
import type { ProviderMetricsAccumulator } from "./metrics"
import type { Agent } from "./types"

export type BackgroundAgentTask = {
  kind: "summary"
  id: number
  startedAt: number
  agent: Agent
  snapshot: ContextCompactionSnapshot
  promise: Promise<void>
}

type SummarySubagentDeps = {
  context: ContextManagerLike
  onEvent?: (event: RunUiEvent) => void
  onBackgroundContextUpdate?: () => void | Promise<void>
  activeHypothesisSummary?: string
  compactPrompt: (messages: Array<{ role: string; content: string }>, options?: { tokenBudget?: number; preferredLanguage?: string; activeHypothesis?: string }) => string
  summaryLanguageHint: (context: ContextManagerLike, messages: Array<{ role: string; content: string }>) => string | undefined
  runProviderTurn: (input: {
    agent: Agent
    prompt: string
    messages: []
    providerMessages: Array<{ role: "system" | "user"; content: string }>
    tools: []
    providerMetrics?: ProviderMetricsAccumulator
    emitDeltas?: boolean
    observeContextUsage?: boolean
  }) => Promise<{ text: string; failureText?: string }>
}

export function createSummaryTask(id: number, agent: Agent, snapshot: ContextCompactionSnapshot): BackgroundAgentTask {
  return {
    kind: "summary",
    id,
    startedAt: Date.now(),
    agent,
    snapshot,
    promise: Promise.resolve(),
  }
}

export async function runSummarySubagentTask(
  deps: SummarySubagentDeps,
  task: BackgroundAgentTask,
  providerMetrics?: ProviderMetricsAccumulator,
) {
  const providerMessages = [
    { role: "system" as const, content: `${task.agent.systemPrompt}\n\nMode: ${task.agent.mode}\nTools: none` },
    {
      role: "user" as const,
      content: deps.compactPrompt(task.snapshot.providerMessages, {
        tokenBudget: deps.context.strategyState.dynamicSummaryTokenBudget,
        preferredLanguage: deps.summaryLanguageHint(deps.context, task.snapshot.providerMessages),
        activeHypothesis: deps.activeHypothesisSummary,
      }),
    },
  ]
  try {
    const turn = await deps.runProviderTurn({
      agent: task.agent,
      prompt: "Summarize conversation for context compaction",
      messages: [],
      providerMessages,
      tools: [],
      providerMetrics,
      emitDeltas: false,
      observeContextUsage: false,
    })
    if (turn.failureText) throw new Error(turn.failureText)
    const extracted = extractCompactSummary(turn.text)
    const compacted = deps.context.compactSnapshot(extracted, task.snapshot)
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
    deps.onEvent?.({ type: "context_compaction", status: "failed", elapsedMs: Date.now() - task.startedAt, error: error instanceof Error ? error.message : String(error) })
  }
}
