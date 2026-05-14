import { describe, expect, test } from "bun:test"
import { AdaptiveCachePolicy, extraCachedTokenBudget } from "../../src/cache-policy"

describe("cache policy", () => {
  test("promotes auto strategy when price ratio makes extra cached prefix worthwhile", () => {
    const policy = new AdaptiveCachePolicy({
      strategy: "auto",
      pricing: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 },
      minCalls: 1,
      minMissTokens: 100,
      minStaticPrefixTokens: 10,
    })

    policy.observeRequest({
      mode: "build",
      prompt: "fix",
      messages: [],
      providerMessages: [{ role: "system", content: "stable prefix ".repeat(100) }, { role: "user", content: "fix" }],
      tools: [],
    })
    expect(policy.shouldSendStaticContext(1)).toBe(false)

    policy.observeUsage({ type: "usage", inputTokens: 2_000, outputTokens: 20, cacheHitTokens: 400, cacheMissTokens: 1_600 })

    expect(policy.shouldSendStaticContext(1)).toBe(true)
    expect(policy.snapshot()).toMatchObject({ activeStaticContextStrategy: "every-step", cacheHitCostRatio: 0.02 })
  })

  test("computes cached token budget from pricing ratio", () => {
    expect(extraCachedTokenBudget(100, { inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 })).toBe(4_900)
  })
})
