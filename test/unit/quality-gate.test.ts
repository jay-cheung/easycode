import { describe, expect, test } from "bun:test"
import path from "node:path"
import { formatQualityGateReport, parseArgs, plannedChecks, runQualityGate } from "../../dev/quality/quality-gate"

describe("quality gate", () => {
  test("plans the unified gate checks", () => {
    expect(plannedChecks()).toEqual(["typecheck", "tests", "eval_fake", "apix_subset", "cache_benchmark", "build", "provider_gate"])
  })

  test("parses provider arguments", () => {
    expect(parseArgs(["--providers", "openai,deepseek,openai-compatible", "--apix-limit", "2", "--no-cache"])).toMatchObject({
      providers: ["openai", "deepseek", "openai-compatible"],
      apixLimit: 2,
      providerCache: false,
    })
  })

  test("parses insecure TLS override flags", () => {
    const originalValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    try {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      expect(parseArgs(["--provider", "deepseek", "--insecure"])).toMatchObject({
        insecure: true,
        providers: ["deepseek"],
      })
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED as string | undefined).toBe("0")
    } finally {
      if (originalValue === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalValue
    }
  })

  test("formats a concise report", () => {
    const markdown = formatQualityGateReport({
      schemaVersion: 1,
      runID: "test-run",
      createdAt: "2026-06-02T00:00:00.000Z",
      root: "/tmp/easycode",
      status: "passed",
      checks: [
        { name: "typecheck", status: "passed", summary: "passed in 1.0s" },
        { name: "tests", status: "passed", summary: "passed in 2.0s" },
      ],
    })

    expect(markdown).toContain("# Quality Gate 2026-06-02T00:00:00.000Z")
    expect(markdown).toContain("status: passed")
    expect(markdown).toContain("- typecheck: passed - passed in 1.0s")
  })

  test("can run the unified gate with fake provider checks only", async () => {
    const { report, paths } = await runQualityGate({
      root: path.resolve(import.meta.dir, "../.."),
      checks: ["provider_gate"],
      providers: ["fake"],
      smokeTaskIDs: ["EC-001"],
      providerApix: false,
      providerCache: false,
      writeReport: false,
    })

    expect(report.status).toBe("passed")
    expect(report.checks.at(-1)).toMatchObject({
      name: "provider_gate",
      status: "passed",
    })
    expect(paths).toBeUndefined()
  })
})
