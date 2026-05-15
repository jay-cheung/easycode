import { describe, expect, test } from "bun:test"
import { extraCachedTokenBudget } from "../../src/cache-policy"
import { ContextManager } from "../../src/context"
import { createAgent } from "../../src/agent"

describe("cache policy", () => {
  test("plans auto from every-step by default", () => {
    const context = new ContextManager()
    const plan = context.planRequest({ step: 1, cacheStrategy: "auto", agent: createAgent("build"), skills: [], tools: [] })

    expect(plan.strategyState.staticContextStrategy).toBe("every-step")
    expect(plan.providerMessages[0]?.content).toContain("Available tools:")
  })

  test("auto observes before proposing an adaptive candidate", () => {
    const context = new ContextManager()
    context.planRequest({ step: 1, cacheStrategy: "auto", agent: createAgent("build"), skills: [], tools: [] })
    for (let i = 0; i < 5; i += 1) context.observeUsage({ inputTokens: 1_000, outputTokens: 10, cacheHitTokens: 700, cacheMissTokens: 300 })
    expect(context.strategyState.toolResultTokenBudget).toBe(1_200)

    for (let i = 0; i < 5; i += 1) context.observeUsage({ inputTokens: 1_000, outputTokens: 10, cacheHitTokens: 500, cacheMissTokens: 500 })
    expect(context.strategyState.toolResultTokenBudget).toBe(1_200)

    for (let i = 0; i < 5; i += 1) context.observeUsage({ inputTokens: 1_000, outputTokens: 10, cacheHitTokens: 500, cacheMissTokens: 500 })
    const candidate = context.strategyState
    expect(candidate.toolResultTokenBudget).toBeLessThan(1_200)
  })

  test("rolls back a negative adaptive candidate after observed degradation", () => {
    const context = new ContextManager()
    context.planRequest({ step: 1, cacheStrategy: "auto", agent: createAgent("build"), skills: [], tools: [] })
    for (let i = 0; i < 5; i += 1) context.observeUsage({ inputTokens: 1_000, outputTokens: 10, cacheHitTokens: 700, cacheMissTokens: 300 })
    for (let i = 0; i < 10; i += 1) context.observeUsage({ inputTokens: 1_000, outputTokens: 10, cacheHitTokens: 500, cacheMissTokens: 500 })

    expect(context.strategyState.toolResultTokenBudget).toBeLessThan(1_200)

    for (let i = 0; i < 5; i += 1) context.observeUsage({ inputTokens: 1_000, outputTokens: 10, cacheHitTokens: 600, cacheMissTokens: 400 })

    expect(context.strategyState.toolResultTokenBudget).toBe(1_200)
  })

  test("computes cached token budget from pricing ratio", () => {
    expect(extraCachedTokenBudget(100, { inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 })).toBe(4_900)
  })
})
