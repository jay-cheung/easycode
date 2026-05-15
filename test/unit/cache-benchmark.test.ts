import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runCacheBenchmark } from "../../src/cache-benchmark"

describe("cache benchmark", () => {
  test("simulates cache hit rate and effective token cost for benchmark profiles", async () => {
    const report = await runCacheBenchmark({ root: path.resolve(import.meta.dir, "../.."), provider: "simulated" })
    const balanced = report.summaries.find((summary) => summary.profile === "balanced")
    const cacheHeavy = report.summaries.find((summary) => summary.profile === "cache-heavy")
    const auto = report.summaries.find((summary) => summary.profile === "auto")

    expect(balanced).toBeDefined()
    expect(cacheHeavy).toBeDefined()
    expect(auto).toBeDefined()
    expect(balanced?.inputTokens).toBeGreaterThan(0)
    expect(cacheHeavy?.hitRate).toBeGreaterThan(balanced?.hitRate ?? 0)
    expect(cacheHeavy?.effectiveTotalTokens).toBeLessThan(balanced?.effectiveTotalTokens ?? 0)
    expect(auto?.acceptedAdjustments).toBeGreaterThan(0)
    expect(auto?.rollbacks).toBeGreaterThan(0)
    expect(report.adaptiveObservations.find((item) => item.taskID === "CACHE-004-auto-accept-candidate")?.acceptedAdjustments).toBeGreaterThan(0)
    expect(report.adaptiveObservations.find((item) => item.taskID === "CACHE-005-auto-rollback-candidate")?.rollbacks).toBeGreaterThan(0)
    expect(report.adaptiveObservations.find((item) => item.taskID === "CACHE-006-auto-maxsteps-pressure")?.finalStrategyState.maxSteps).toBeGreaterThan(8)
  })
})
