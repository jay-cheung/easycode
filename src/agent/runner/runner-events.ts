import type { RunUiEvent } from "../../ui/timeline"
import type { ProviderMetricsAccumulator } from "../metrics"
import { finalizeProviderMetrics } from "../metrics"

export function emitRunDoneEvent(
  onEvent: ((event: RunUiEvent) => void) | undefined,
  status: string,
  providerMetrics: ProviderMetricsAccumulator | undefined,
) {
  if (providerMetrics && providerMetrics.calls > 0) {
    onEvent?.({ type: "provider_metrics", metrics: finalizeProviderMetrics(providerMetrics) })
  }
  onEvent?.({ type: "run_done", status })
}

export function emitPlanExitText(
  onEvent: ((event: RunUiEvent) => void) | undefined,
  onTextDelta: ((text: string) => void) | undefined,
  text: string,
) {
  onEvent?.({ type: "text_delta", text })
  onTextDelta?.(text)
}
