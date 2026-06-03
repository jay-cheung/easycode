import { describe, expect, test } from "bun:test"
import path from "node:path"
import { formatQualityGateReport, parseArgs, plannedChecksForPreset, runQualityGate } from "../../dev/quality/quality-gate"

describe("quality gate", () => {
  test("plans the expected checks for each preset", () => {
    expect(plannedChecksForPreset("dev")).toEqual(["typecheck", "tests", "eval_fake", "apix_subset", "cache_benchmark"])
    expect(plannedChecksForPreset("full")).toEqual(["typecheck", "tests", "eval_fake", "apix_full", "cache_benchmark", "build"])
    expect(plannedChecksForPreset("provider")).toEqual(["provider_gate"])
  })

  test("parses preset and provider arguments", () => {
    expect(parseArgs(["--preset", "provider", "--providers", "openai,deepseek,openai-compatible", "--apix-limit", "2", "--no-cache"])).toMatchObject({
      preset: "provider",
      providers: ["openai", "deepseek", "openai-compatible"],
      apixLimit: 2,
      providerCache: false,
    })
    expect(() => parseArgs(["--preset", "bad"])).toThrow("--preset must be dev, full, or provider")
  })

  test("formats a concise report", () => {
    const markdown = formatQualityGateReport({
      schemaVersion: 1,
      runID: "test-run",
      createdAt: "2026-06-02T00:00:00.000Z",
      root: "/tmp/easycode",
      preset: "dev",
      status: "passed",
      checks: [
        { name: "typecheck", status: "passed", summary: "passed in 1.0s" },
        { name: "tests", status: "passed", summary: "passed in 2.0s" },
      ],
    })

    expect(markdown).toContain("# Quality Gate 2026-06-02T00:00:00.000Z")
    expect(markdown).toContain("preset: dev")
    expect(markdown).toContain("- typecheck: passed - passed in 1.0s")
  })

  test("can run the provider preset with fake locally", async () => {
    const { report, paths } = await runQualityGate({
      root: path.resolve(import.meta.dir, "../.."),
      preset: "provider",
      providers: ["fake"],
      smokeTaskIDs: ["EC-001"],
      providerApix: false,
      providerCache: false,
      writeReport: false,
    })

    expect(report.status).toBe("passed")
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({
      name: "provider_gate",
      status: "passed",
    })
    expect(paths).toBeUndefined()
  })
})
