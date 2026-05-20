import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runCacheBenchmark } from "../../src/cache-benchmark"

describe("cache benchmark", () => {
  test("simulates cache hit rate and effective token cost for fixed every-step profile", async () => {
    const report = await runCacheBenchmark({ root: path.resolve(import.meta.dir, "../.."), provider: "simulated", suite: "real" })
    const everyStep = report.summaries.find((summary) => summary.profile === "every-step")

    expect(report.summaries.map((summary) => summary.profile)).toEqual(["every-step"])
    expect(everyStep?.inputTokens).toBeGreaterThan(0)
    expect(everyStep?.cacheHitTokens).toBeGreaterThan(0)
    expect(everyStep?.effectiveTotalTokens).toBeGreaterThan(0)
  })
})
