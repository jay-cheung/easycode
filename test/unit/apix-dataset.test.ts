import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runAPIxEval } from "../../src/evals/apix"
import { contextLedgerForCase } from "../../src/evals/apix/case"
import { validateCase } from "../../src/evals/apix/validation"

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

const supportedExpectedFields = new Set(["exact", "json_schema", "must_include", "must_include_any", "must_not_include", "aliases", "regex", "numeric"])

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
      thinking: false,
      json: true,
      table: false,
      quiet: true,
    })

    expect(report.count).toBe(5)
    expect(report.quality.hardGateTotal).toBeGreaterThan(0)
    expect(report.quality.softOracleTotal).toBeGreaterThanOrEqual(0)
    expect(report.quality.gatedTotal).toBe(report.quality.hardGateTotal)
    expect(report.quality.strictSLA).toBeGreaterThanOrEqual(0)
    expect(report.quality.trust.taintedTotal).toBeGreaterThan(0)
    expect(report.quality.trust.notDeterministicallyValidated.length).toBeGreaterThan(0)
    expect(report.results.every((result) => result.evaluationMode === "hard_gate" || result.scoreOnly)).toBe(true)
    expect(report.results.filter((result) => result.scoreOnly).every((result) => result.trust.level === "tainted")).toBe(true)
  })

  test("does not allow case-specific APIx prompt specializations", async () => {
    const caseSource = await Bun.file(path.resolve(import.meta.dir, "../../src/evals/apix/case.ts")).text()
    expect(caseSource).not.toMatch(/task\.id\s*={2,3}\s*["']APIX-\d{3}["']/)
  })

  test("accepts explicit aliases without accepting wrong facts", async () => {
    const root = path.resolve(import.meta.dir, "../..")
    const manifest = await Bun.file(path.join(root, "evals/apix/tasks.json")).json() as { cases: APIxCase[] }
    const golfCase = manifest.cases.find((item) => item.id === "APIX-012")
    const syntaxCase = manifest.cases.find((item) => item.id === "APIX-034")
    if (!golfCase || !syntaxCase) throw new Error("missing APIx alias cases")

    const emptyUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
    const cacheEvaluation = { eligible: true }

    expect(validateCase(golfCase, "2024 高尔夫 R-Line，1万公里，轻微剐蹭，长沙。", emptyUsage, cacheEvaluation)).toEqual([])
    expect(validateCase(golfCase, "2024 高尔夫 R-Line，2万公里，轻微剐蹭，长沙。", emptyUsage, cacheEvaluation)).toContain('missing "一万公里"')
    expect(validateCase(syntaxCase, "第127行缺少右括号 )。", emptyUsage, cacheEvaluation)).toEqual([])
    expect(validateCase(syntaxCase, "第128行缺少右括号 )。", emptyUsage, cacheEvaluation)).toContain('missing "line 127"')
  })

  test("warms cache-gated cases before measuring cache hit ratio", async () => {
    delete process.env.FAKE_PROMPT_CACHE_MIN_PREFIX_TOKENS
    const report = await runAPIxEval({
      root: path.resolve(import.meta.dir, "../.."),
      provider: "fake",
      ids: ["APIX-001"],
      thinking: false,
      json: true,
      table: false,
      quiet: true,
    })
    const result = report.results[0]

    expect(result.passed).toBe(true)
    expect(result.warmupUsage?.cacheHitTokens).toBe(0)
    expect(result.measuredUsage?.cacheHitTokens).toBe(800)
    expect(result.usage.cacheHitTokens).toBe(800)
  })

  test("reports cache gates as not eligible when the stable prefix is below the provider minimum", async () => {
    const previous = process.env.FAKE_PROMPT_CACHE_MIN_PREFIX_TOKENS
    process.env.FAKE_PROMPT_CACHE_MIN_PREFIX_TOKENS = "999999"
    try {
      const report = await runAPIxEval({
        root: path.resolve(import.meta.dir, "../.."),
        provider: "fake",
        ids: ["APIX-001"],
        thinking: false,
        json: true,
        table: false,
        quiet: true,
      })
      const result = report.results[0]

      expect(result.passed).toBe(false)
      expect(result.primaryCause).toBe("cache_not_eligible")
      expect(result.failures.some((failure) => failure.includes("cache not eligible"))).toBe(true)
      expect(result.warmupUsage).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.FAKE_PROMPT_CACHE_MIN_PREFIX_TOKENS
      else process.env.FAKE_PROMPT_CACHE_MIN_PREFIX_TOKENS = previous
    }
  })

  test("builds code-aware fixture ledger hints without changing the golden dataset", async () => {
    const root = path.resolve(import.meta.dir, "../..")
    const manifest = await Bun.file(path.join(root, "evals/apix/tasks.json")).json() as { cases: APIxCase[] }
    const mutationCase = manifest.cases.find((item) => item.id === "APIX-032")
    const syntaxCase = manifest.cases.find((item) => item.id === "APIX-034")
    const apiCase = manifest.cases.find((item) => item.id === "APIX-037")
    if (!mutationCase || !syntaxCase || !apiCase) throw new Error("missing APIx code cases")

    const mutationFixture = await Bun.file(path.join(root, mutationCase.fixture)).text()
    const syntaxFixture = await Bun.file(path.join(root, syntaxCase.fixture)).text()
    const apiFixture = await Bun.file(path.join(root, apiCase.fixture)).text()

    const mutationLedger = contextLedgerForCase(mutationCase, mutationFixture)
    const syntaxLedger = contextLedgerForCase(syntaxCase, syntaxFixture)
    const apiLedger = contextLedgerForCase(apiCase, apiFixture)

    const mutationLedgerText = (mutationLedger.current ?? []).map((record) => record.value).join("\n")
    expect(mutationLedgerText).toContain("code_numeric_state=FINAL_COUNTER has 15 numeric mutations")
    expect(mutationLedgerText).not.toContain("FINAL_COUNTER=47")
    expect((syntaxLedger.current ?? []).map((record) => record.value).join("\n")).toContain("code_diagnostics=line 23: line 128: // missing closing parenthesis before this line")
    expect((apiLedger.current ?? []).map((record) => record.value).join("\n")).toContain("code_constraints=line 1: Framework version: v1.0 only. | line 2: Allowed API: legacyFetch(path, options). | line 3: Forbidden v2 APIs: createClientV2, newClient.")
  })
})
