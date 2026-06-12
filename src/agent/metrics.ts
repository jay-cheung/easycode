import { defaultCachePricing, type CachePricing } from "../cache-policy"
import type { ProviderEvent } from "../provider"
import type { ProviderRunMetrics } from "../ui/timeline"
import type { SubagentRole } from "./types"
import type { ReasoningEffort } from "../settings"

export type ProviderMetricsAccumulator = {
  provider: string
  model?: string
  source?: "main" | "subagent"
  subagentRole?: SubagentRole
  thinking?: boolean
  effort?: ReasoningEffort
  maxOutputTokens?: number
  maxProviderCalls?: number
  pricing: CachePricing
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  totalTokens?: number
  reasoningTokens?: number
  providerElapsedMs: number
  firstResponseMs?: number
}

type ProviderMetricCall = {
  startedAt: number
  firstResponseMs?: number
}

export function createProviderMetrics(
  provider: string,
  model?: string,
  metadata: Partial<Pick<ProviderMetricsAccumulator, "source" | "subagentRole" | "thinking" | "effort" | "maxOutputTokens" | "maxProviderCalls">> = {},
): ProviderMetricsAccumulator {
  return {
    provider,
    model,
    source: metadata.source,
    subagentRole: metadata.subagentRole,
    thinking: metadata.thinking,
    effort: metadata.effort,
    maxOutputTokens: metadata.maxOutputTokens,
    maxProviderCalls: metadata.maxProviderCalls,
    pricing: defaultCachePricing(),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    providerElapsedMs: 0,
  }
}

export function startProviderMetricCall(metrics?: ProviderMetricsAccumulator): ProviderMetricCall | undefined {
  if (!metrics) return undefined
  metrics.calls += 1
  return { startedAt: Date.now() }
}

export function observeProviderMetricEvent(metrics: ProviderMetricsAccumulator | undefined, call: ProviderMetricCall | undefined, event: ProviderEvent) {
  if (!metrics || !call) return
  if (event.type === "text_delta" && call.firstResponseMs === undefined) {
    call.firstResponseMs = Date.now() - call.startedAt
    metrics.firstResponseMs = metrics.firstResponseMs === undefined ? call.firstResponseMs : Math.min(metrics.firstResponseMs, call.firstResponseMs)
  }
  if (event.type !== "usage") return
  mergeProviderUsage(metrics, event)
}

export function finishProviderMetricCall(metrics: ProviderMetricsAccumulator | undefined, call: ProviderMetricCall | undefined) {
  if (!metrics || !call) return
  metrics.providerElapsedMs += Date.now() - call.startedAt
}

function mergeProviderUsage(target: ProviderMetricsAccumulator, event: Extract<ProviderEvent, { type: "usage" }>) {
  target.inputTokens += event.inputTokens
  target.outputTokens += event.outputTokens
  target.cacheHitTokens += event.cacheHitTokens ?? 0
  target.cacheMissTokens += event.cacheMissTokens ?? Math.max(0, event.inputTokens - (event.cacheHitTokens ?? 0))
  target.totalTokens = (target.totalTokens ?? 0) + (event.totalTokens ?? event.inputTokens + event.outputTokens)
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (event.reasoningTokens ?? 0)
}

export function finalizeProviderMetrics(metrics: ProviderMetricsAccumulator): ProviderRunMetrics {
  const hitRate = metrics.inputTokens === 0 ? 0 : metrics.cacheHitTokens / metrics.inputTokens
  const outputSeconds = metrics.providerElapsedMs / 1_000
  const outputTokensPerSecond = outputSeconds <= 0 || metrics.outputTokens === 0 ? undefined : metrics.outputTokens / outputSeconds
  return {
    provider: metrics.provider,
    model: metrics.model,
    source: metrics.source,
    subagentRole: metrics.subagentRole,
    thinking: metrics.thinking,
    effort: metrics.effort,
    maxOutputTokens: metrics.maxOutputTokens,
    maxProviderCalls: metrics.maxProviderCalls,
    calls: metrics.calls,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheHitTokens: metrics.cacheHitTokens,
    cacheMissTokens: metrics.cacheMissTokens,
    totalTokens: metrics.totalTokens,
    reasoningTokens: metrics.reasoningTokens,
    hitRate,
    providerElapsedMs: metrics.providerElapsedMs,
    firstResponseMs: metrics.firstResponseMs,
    outputTokensPerSecond,
    effectiveCost: metrics.cacheHitTokens * metrics.pricing.inputCacheHit + metrics.cacheMissTokens * metrics.pricing.inputCacheMiss + metrics.outputTokens * metrics.pricing.output,
    rates: metrics.pricing,
  }
}
