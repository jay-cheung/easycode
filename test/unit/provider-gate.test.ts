import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { formatProviderGateReport, runProviderGate } from "../../dev/quality/provider-gate"

describe("provider gate", () => {
  test("records missing provider environment as an explicit skip", async () => {
    const previous = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    const reportDir = await mkdtemp(path.join(os.tmpdir(), "easycode-provider-gate-skip-"))
    try {
      const { report, paths } = await runProviderGate({
        root: path.resolve(import.meta.dir, "../.."),
        providers: ["openai"],
        reportDir,
        apix: false,
        cache: false,
      })

      expect(report.status).toBe("skipped")
      expect(report.providers[0]).toMatchObject({
        provider: "openai",
        status: "skipped",
      })
      expect(report.providers[0].checks[0]).toMatchObject({
        name: "env",
        status: "skipped",
      })
      expect(paths?.jsonPath.startsWith(reportDir)).toBe(true)
      expect(await Bun.file(paths?.jsonPath ?? "").exists()).toBe(true)
      expect(await Bun.file(paths?.markdownPath ?? "").exists()).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
      await rm(reportDir, { recursive: true, force: true })
    }
  })

  test("can run a deterministic smoke gate and render the report", async () => {
    const reportDir = await mkdtemp(path.join(os.tmpdir(), "easycode-provider-gate-pass-"))
    try {
      const { report } = await runProviderGate({
        root: path.resolve(import.meta.dir, "../.."),
        providers: ["fake"],
        reportDir,
        smokeTaskIDs: ["EC-001"],
        apix: false,
        cache: false,
      })
      const markdown = formatProviderGateReport(report)

      expect(report.status).toBe("passed")
      expect(report.providers[0].checks.map((check) => check.name)).toEqual(["env", "smoke_eval"])
      expect(markdown).toContain("## fake: passed")
      expect(markdown).toContain("smoke_eval: passed")
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  })

  test("uses apixLimit when explicit APIx ids are not supplied", async () => {
    const { report } = await runProviderGate({
      root: path.resolve(import.meta.dir, "../.."),
      providers: ["fake"],
      smokeTaskIDs: ["EC-001"],
      apixLimit: 1,
      cache: false,
      writeReport: false,
    })
    const apix = report.providers[0].checks.find((check) => check.name === "apix_subset")

    expect(report.status).toBe("passed")
    expect(apix).toMatchObject({
      status: "passed",
      summary: "1/1 hard-gate APIx cases passed",
    })
    expect((apix?.details as { ids?: string[] }).ids).toEqual(["APIX-001"])
  })
})
