import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runAPIxEval } from "../../src/apix-eval"

type APIxCase = {
  id: string
  dimension: string
  priority: "P0" | "P1" | "P2"
  evaluation_mode: "hard_gate" | "soft_oracle" | "future_capability" | "benchmark_defect"
  goal: string
  architecture_pressure: string[]
  fixture: string
  turns: Array<{ role: "user" | "assistant"; content: string }>
  expected: Record<string, unknown>
  metrics: { quality_gate: "must_pass" | "score_only"; track: string[] }
}

const supportedExpectedFields = new Set(["exact", "json_schema", "must_include", "must_include_any", "must_not_include", "regex", "numeric"])

describe("APIx golden dataset manifest", () => {
  test("uses the structured task shape expected by the APIx runner", async () => {
    const manifest = await Bun.file(path.resolve(import.meta.dir, "../../evals/apix/tasks.json")).json() as { cases: APIxCase[] }
    const ids = new Set(manifest.cases.map((item) => item.id))

    expect(manifest.cases.length).toBe(100)
    expect(ids.size).toBe(manifest.cases.length)

    for (const item of manifest.cases) {
      expect(item.id).toMatch(/^APIX-\d{3}$/)
      expect(item.dimension.length).toBeGreaterThan(0)
      expect(["P0", "P1", "P2"]).toContain(item.priority)
      expect(["hard_gate", "soft_oracle", "future_capability", "benchmark_defect"]).toContain(item.evaluation_mode)
      expect(item.goal.length).toBeGreaterThan(0)
      expect(item.architecture_pressure.length).toBeGreaterThan(0)
      expect(item.fixture).toMatch(/^evals\/apix\/fixtures\//)
      expect(item.turns.length).toBeGreaterThan(0)
      expect(item.turns.every((turn) => turn.role === "user" || turn.role === "assistant")).toBe(true)
      expect(Object.keys(item.expected).length).toBeGreaterThan(0)
      expect(["must_pass", "score_only"]).toContain(item.metrics.quality_gate)
      expect(item.metrics.track.length).toBeGreaterThan(0)
    }
  })

  test("keeps hard-gate cases on implemented validators only", async () => {
    const manifest = await Bun.file(path.resolve(import.meta.dir, "../../evals/apix/tasks.json")).json() as { cases: APIxCase[] }
    const hardGate = manifest.cases.filter((item) => item.evaluation_mode === "hard_gate")
    const softOracle = manifest.cases.filter((item) => item.evaluation_mode === "soft_oracle")

    expect(manifest.cases.length).toBe(100)
    expect(hardGate.length).toBeGreaterThan(0)
    expect(softOracle.length).toBeGreaterThan(0)
    for (const item of hardGate) {
      const unsupported = Object.keys(item.expected).filter((key) => !supportedExpectedFields.has(key))
      expect(unsupported).toEqual([])
    }
  })

  test("materializes all required non-conversational fixtures", async () => {
    const manifest = await Bun.file(path.resolve(import.meta.dir, "../../evals/apix/tasks.json")).json() as { cases: APIxCase[] }
    const inlineDimensions = new Set(["system_prompt_adherence", "active_window_coreference"])
    const cases = manifest.cases.filter((item) => !inlineDimensions.has(item.dimension))

    expect(cases.length).toBe(80)
    for (const item of cases) {
      const file = Bun.file(path.resolve(import.meta.dir, "../..", item.fixture))
      expect(await file.exists()).toBe(true)
      expect((await file.text()).length).toBeGreaterThan(0)
    }
  })

  test("reports hard-gate SLA separately from soft oracle cases", async () => {
    const report = await runAPIxEval({
      root: path.resolve(import.meta.dir, "../.."),
      provider: "fake",
      limit: 5,
      cacheStrategy: "cache-heavy",
      thinking: false,
      json: true,
      table: false,
      quiet: true,
    })

    expect(report.count).toBe(5)
    expect(report.quality.hardGateTotal).toBeGreaterThan(0)
    expect(report.quality.softOracleTotal).toBeGreaterThanOrEqual(0)
    expect(report.quality.gatedTotal).toBe(report.quality.hardGateTotal)
    expect(report.results.every((result) => result.evaluationMode === "hard_gate" || result.scoreOnly)).toBe(true)
  })
})
