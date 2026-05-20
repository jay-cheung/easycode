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

function numberFromEnv(name: string, fallback: number) {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
