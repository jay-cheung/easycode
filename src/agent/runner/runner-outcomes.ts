import type { AgentRunResult } from "../types"
import type { ProviderMetricsAccumulator } from "../metrics"
import type { RunUiEvent } from "../../ui/timeline"
import type { ContextManagerLike } from "../../context"
import type { RunAspect } from "../../instrumentation"
import { canonicalizeAssistantHistory } from "../../message"
import { appendOutput, assistantMessage } from "./runner-helpers"
import { emitRunDoneEvent } from "./runner-events"

export function createCancelledRunResult(input: {
  aspect: RunAspect
  context: ContextManagerLike
  onEvent?: (event: RunUiEvent) => void
  reasoningTranscript: string
  usedTools: string[]
  output?: string
  providerMetrics?: ProviderMetricsAccumulator
}): AgentRunResult {
  const text = appendOutput((input.output ?? "Run cancelled by user.").trim(), "Continue with another message when ready.")
  input.onEvent?.({ type: "failure", text })
  const canonical = canonicalizeAssistantHistory(input.reasoningTranscript, text)
  input.context.add(assistantMessage(canonical.reasoningText, canonical.text))
  const state = input.aspect.transition("cancelled", { usedTools: input.usedTools })
  emitRunDoneEvent(input.onEvent, "cancelled", input.providerMetrics)
  return {
    status: "cancelled",
    failureReason: "cancelled",
    text,
    reasoning: input.reasoningTranscript,
    messages: input.context.state.messages,
    usedTools: input.usedTools,
    state,
  }
}
