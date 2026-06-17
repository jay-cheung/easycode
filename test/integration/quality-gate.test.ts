import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function tmpdir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

async function runQualityCli(script: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, EASYCODE_DISABLE_GLOBAL_ENV: "1" },
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, status }
}

describe("quality gate integration", () => {
  test("provider-gate CLI runs a deterministic fake provider smoke flow and writes reports", async () => {
    const reportDir = await tmpdir("easycode-provider-gate-e2e-")
    try {
      const result = await runQualityCli("dev/quality/provider-gate.ts", [
        "--provider",
        "fake",
        "--smoke-ids",
        "EC-001",
        "--no-apix",
        "--no-cache",
        "--report-dir",
        reportDir,
        "--json",
      ])

      expect(result.status).toBe(0)
      expect(result.stderr).toContain("[provider-gate] wrote")
      const parsed = JSON.parse(result.stdout) as {
        report: { status: string; providers: Array<{ provider: string; status: string; checks: Array<{ name: string; status: string }> }> }
        paths: { jsonPath: string; markdownPath: string }
      }
      expect(parsed.report.status).toBe("passed")
      expect(parsed.report.providers[0]).toMatchObject({
        provider: "fake",
        status: "passed",
      })
      expect(parsed.report.providers[0].checks.map((check) => check.name)).toEqual(["readiness", "env", "smoke_eval"])
      expect(parsed.report.providers[0].checks.every((check) => check.status === "passed")).toBe(true)
      expect(parsed.paths.jsonPath.startsWith(reportDir)).toBe(true)
      expect(parsed.paths.markdownPath.startsWith(reportDir)).toBe(true)
      expect(await Bun.file(parsed.paths.jsonPath).exists()).toBe(true)
      expect(await Bun.file(parsed.paths.markdownPath).text()).toContain("## fake: passed")
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  }, { timeout: 20_000 })

  test("quality-gate CLI can run only provider_gate and persist the unified report", async () => {
    const reportDir = await tmpdir("easycode-quality-gate-e2e-")
    try {
      const result = await runQualityCli("dev/quality/quality-gate.ts", [
        "--checks",
        "provider_gate",
        "--provider",
        "fake",
        "--smoke-ids",
        "EC-001",
        "--no-apix",
        "--no-cache",
        "--report-dir",
        reportDir,
        "--json",
      ])

      expect(result.status).toBe(0)
      expect(result.stderr).toContain("[quality-gate] wrote")
      const parsed = JSON.parse(result.stdout) as {
        report: { status: string; checks: Array<{ name: string; status: string; summary: string }> }
        paths: { jsonPath: string; markdownPath: string }
      }
      expect(parsed.report.status).toBe("passed")
      expect(parsed.report.checks).toEqual([
        expect.objectContaining({
          name: "provider_gate",
          status: "passed",
          summary: "fake:passed",
        }),
      ])
      expect(await Bun.file(parsed.paths.jsonPath).exists()).toBe(true)
      expect(await Bun.file(parsed.paths.markdownPath).text()).toContain("- provider_gate: passed - fake:passed")
    } finally {
      await rm(reportDir, { recursive: true, force: true })
    }
  }, { timeout: 20_000 })
})
