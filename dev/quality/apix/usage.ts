import type { ProviderEvent } from "../../../src/provider"
import type { APIxUsage, CacheEvaluation, APIxCase } from "./types"

export function emptyUsage(): APIxUsage {
  return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: undefined, reasoningTokens: undefined }
}

export function mergeUsage(target: APIxUsage, event: Extract<ProviderEvent, { type: "usage" }>) {
  target.inputTokens += event.inputTokens
  target.outputTokens += event.outputTokens
  target.cacheHitTokens += event.cacheHitTokens ?? 0
  target.cacheMissTokens += event.cacheMissTokens ?? Math.max(0, event.inputTokens - (event.cacheHitTokens ?? 0))
  target.totalTokens = (target.totalTokens ?? 0) + (event.totalTokens ?? event.inputTokens + event.outputTokens)
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (event.reasoningTokens ?? 0)
}

export function cacheEvaluationForCase(task: APIxCase, minPrefixTokens: number | undefined, staticPrefixTokens: number): CacheEvaluation {
  const requiredRatio = task.metrics.min_cache_hit_ratio_after_warmup
  if (requiredRatio === undefined) return { eligible: true, staticPrefixTokens }
  if (minPrefixTokens !== undefined && staticPrefixTokens < minPrefixTokens) {
    return {
      requiredRatio,
      eligible: false,
      reason: `static prefix ${staticPrefixTokens} tokens below provider cache minimum ${minPrefixTokens}`,
      staticPrefixTokens,
      minPrefixTokens,
    }
  }
  return { requiredRatio, eligible: true, staticPrefixTokens, ...(minPrefixTokens !== undefined ? { minPrefixTokens } : {}) }
}
