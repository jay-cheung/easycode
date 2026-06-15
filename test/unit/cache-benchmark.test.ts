import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runCacheBenchmark } from "../../dev/quality/cache-benchmark"

describe("cache benchmark", () => {
  test("simulates cache hit rate and effective token cost for the default benchmark path", async () => {
    const report = await runCacheBenchmark({ root: path.resolve(import.meta.dir, "../.."), provider: "simulated", suite: "real" })
    const summary = report.summary

    expect(report.summaries).toHaveLength(1)
    expect(report.summaries[0]).toEqual(summary)
    expect(summary.inputTokens).toBeGreaterThan(0)
    expect(summary.cacheHitTokens).toBeGreaterThan(0)
    expect(summary.effectiveTotalTokens).toBeGreaterThan(0)
  }, 30_000)
})
