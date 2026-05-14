import { estimateTextTokens } from "./context"
import type { ProviderEvent, ProviderInput } from "./provider/types"

export type CacheStrategy = "balanced" | "cache-heavy" | "auto"
export type StaticContextStrategy = "first-step" | "every-step"

export type CachePricing = {
  inputCacheHit: number
  inputCacheMiss: number
  output: number
}

export type CachePolicySnapshot = {
  strategy: CacheStrategy
  activeStaticContextStrategy: StaticContextStrategy
  observedCalls: number
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  hitRate: number
  cacheHitCostRatio: number
  extraCachedTokenBudget: number
  staticPrefixTokens: number
}

export type AdaptiveCachePolicyOptions = {
  strategy: CacheStrategy
  pricing: CachePricing
  minCalls?: number
  minMissTokens?: number
  minStaticPrefixTokens?: number
  minHeavyBenefitRatio?: number
  maxBalancedHitRate?: number
}

export class AdaptiveCachePolicy {
  private activeStaticContextStrategy: StaticContextStrategy
  private observedCalls = 0
  private inputTokens = 0
  private cacheHitTokens = 0
  private cacheMissTokens = 0
  private staticPrefixTokens = 0
  private readonly minCalls: number
  private readonly minMissTokens: number
  private readonly minStaticPrefixTokens: number
  private readonly minHeavyBenefitRatio: number
  private readonly maxBalancedHitRate: number

  constructor(private readonly options: AdaptiveCachePolicyOptions) {
    this.activeStaticContextStrategy = options.strategy === "cache-heavy" ? "every-step" : "first-step"
    this.minCalls = options.minCalls ?? numberFromEnv("EASYCODE_CACHE_AUTO_MIN_CALLS", 2)
    this.minMissTokens = options.minMissTokens ?? numberFromEnv("EASYCODE_CACHE_AUTO_MIN_MISS_TOKENS", 1_024)
    this.minStaticPrefixTokens = options.minStaticPrefixTokens ?? numberFromEnv("EASYCODE_CACHE_AUTO_MIN_STATIC_TOKENS", 128)
    this.minHeavyBenefitRatio = options.minHeavyBenefitRatio ?? numberFromEnv("EASYCODE_CACHE_AUTO_MIN_BENEFIT_RATIO", 1)
    this.maxBalancedHitRate = options.maxBalancedHitRate ?? numberFromEnv("EASYCODE_CACHE_AUTO_MAX_BALANCED_HIT_RATE", 0.6)
  }

  shouldSendStaticContext(step: number) {
    return step === 0 || this.activeStaticContextStrategy === "every-step"
  }

  observeRequest(input: ProviderInput) {
    const staticPrefix = staticPrefixTokens(input)
    if (staticPrefix > this.staticPrefixTokens) this.staticPrefixTokens = staticPrefix
  }

  observeUsage(event: Extract<ProviderEvent, { type: "usage" }>) {
    if (event.cacheHitTokens === undefined && event.cacheMissTokens === undefined) return
    const hit = event.cacheHitTokens ?? 0
    const miss = event.cacheMissTokens ?? Math.max(0, event.inputTokens - hit)
    this.observedCalls += 1
    this.inputTokens += event.inputTokens
    this.cacheHitTokens += hit
    this.cacheMissTokens += miss
    this.maybePromote()
  }

  snapshot(): CachePolicySnapshot {
    const hitRate = this.inputTokens === 0 ? 0 : this.cacheHitTokens / this.inputTokens
    const ratio = cacheHitCostRatio(this.options.pricing)
    return {
      strategy: this.options.strategy,
      activeStaticContextStrategy: this.activeStaticContextStrategy,
      observedCalls: this.observedCalls,
      inputTokens: this.inputTokens,
      cacheHitTokens: this.cacheHitTokens,
      cacheMissTokens: this.cacheMissTokens,
      hitRate,
      cacheHitCostRatio: ratio,
      extraCachedTokenBudget: extraCachedTokenBudget(this.cacheMissTokens, this.options.pricing),
      staticPrefixTokens: this.staticPrefixTokens,
    }
  }

  private maybePromote() {
    if (this.options.strategy !== "auto") return
    if (this.activeStaticContextStrategy === "every-step") return
    if (this.observedCalls < this.minCalls) return
    if (this.cacheMissTokens < this.minMissTokens) return
    if (this.staticPrefixTokens < this.minStaticPrefixTokens) return
    if (this.inputTokens > 0 && this.cacheHitTokens / this.inputTokens > this.maxBalancedHitRate) return

    const budget = extraCachedTokenBudget(this.cacheMissTokens, this.options.pricing)
    const benefitRatio = this.staticPrefixTokens === 0 ? 0 : budget / this.staticPrefixTokens
    if (benefitRatio >= this.minHeavyBenefitRatio) this.activeStaticContextStrategy = "every-step"
  }
}

export function defaultCachePricing() {
  return {
    inputCacheHit: numberFromEnv("EASYCODE_CACHE_INPUT_HIT_PRICE", 0.02),
    inputCacheMiss: numberFromEnv("EASYCODE_CACHE_INPUT_MISS_PRICE", 1),
    output: numberFromEnv("EASYCODE_CACHE_OUTPUT_PRICE", 2),
  }
}

export function cacheHitCostRatio(pricing: CachePricing) {
  if (pricing.inputCacheMiss <= 0) return 1
  return pricing.inputCacheHit / pricing.inputCacheMiss
}

export function extraCachedTokenBudget(cacheMissTokens: number, pricing: CachePricing) {
  const ratio = cacheHitCostRatio(pricing)
  if (ratio <= 0) return Number.POSITIVE_INFINITY
  return cacheMissTokens * ((1 - ratio) / ratio)
}

function staticPrefixTokens(input: ProviderInput) {
  const first = input.providerMessages[0]
  return first?.role === "system" ? estimateTextTokens(first.content) : 0
}

function numberFromEnv(name: string, fallback: number) {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
