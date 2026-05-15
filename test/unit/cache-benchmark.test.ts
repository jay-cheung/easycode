import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runCacheBenchmark } from "../../src/cache-benchmark"

describe("cache benchmark", () => {
  test("simulates cache hit rate and effective token cost for benchmark profiles", async () => {
    const report = await runCacheBenchmark({ root: path.resolve(import.meta.dir, "../.."), provider: "simulated", suite: "real" })
    const balanced = report.summaries.find((summary) => summary.profile === "balanced")
    const cacheHeavy = report.summaries.find((summary) => summary.profile === "cache-heavy")
    const auto = report.summaries.find((summary) => summary.profile === "auto")
    const autoFrozen = report.summaries.find((summary) => summary.profile === "auto-frozen")

    expect(balanced).toBeDefined()
    expect(cacheHeavy).toBeDefined()
    expect(auto).toBeDefined()
    expect(autoFrozen).toBeDefined()
    expect(balanced?.inputTokens).toBeGreaterThan(0)
    expect(cacheHeavy?.hitRate).toBeGreaterThanOrEqual(balanced?.hitRate ?? 0)
    expect(cacheHeavy?.effectiveTotalTokens).toBeLessThanOrEqual(balanced?.effectiveTotalTokens ?? 0)
    expect(auto?.acceptedAdjustments).toBe(0)
    expect(autoFrozen?.acceptedAdjustments).toBe(0)
  })

  test("reports deterministic adaptive window decisions", async () => {
    const report = await runCacheBenchmark({ root: path.resolve(import.meta.dir, "../.."), provider: "simulated", suite: "adaptive" })
    const auto = report.summaries.find((summary) => summary.profile === "auto")

    expect(auto?.acceptedAdjustments).toBeGreaterThan(0)
    expect(auto?.rollbacks).toBeGreaterThan(0)
    expect(report.adaptiveObservations.find((item) => item.taskID === "CACHE-004-auto-accept-candidate")?.acceptedAdjustments).toBeGreaterThan(0)
    expect(report.adaptiveObservations.find((item) => item.taskID === "CACHE-005-auto-rollback-candidate")?.rollbacks).toBeGreaterThan(0)
    expect(report.adaptiveObservations.find((item) => item.taskID === "CACHE-006-auto-maxsteps-pressure")?.finalStrategyState.maxSteps).toBeGreaterThan(8)
    expect(report.adaptiveCaseSummaries.find((item) => item.taskID === "CACHE-004-auto-accept-candidate")).toMatchObject({ decision: "accept", expected: "accept", passed: true })
    expect(report.adaptiveCaseSummaries.find((item) => item.taskID === "CACHE-005-auto-rollback-candidate")).toMatchObject({ decision: "rollback", expected: "rollback", passed: true })
  })
})
