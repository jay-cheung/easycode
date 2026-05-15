export type CacheStrategy = "balanced" | "cache-heavy" | "auto"
export type StaticContextStrategy = "first-step" | "every-step"

export type CachePricing = {
  inputCacheHit: number
  inputCacheMiss: number
  output: number
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

function numberFromEnv(name: string, fallback: number) {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
