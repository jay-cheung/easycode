import { defaultCachePricing } from "../../cache-policy"
import type { APIxOptions, APIxResult } from "./types"
import { optimizationForCause } from "./validation"

export function summarize(options: APIxOptions, results: APIxResult[]) {
  const gated = results.filter((result) => result.evaluationMode === "hard_gate")
  const softOracle = results.filter((result) => result.evaluationMode === "soft_oracle")
  const passed = gated.filter((result) => result.passed).length
  const p0 = gated.filter((result) => result.priority === "P0")
  const p0Passed = p0.filter((result) => result.passed).length
  const inputTokens = results.reduce((total, result) => total + result.usage.inputTokens, 0)
  const outputTokens = results.reduce((total, result) => total + result.usage.outputTokens, 0)
  const cacheHitTokens = results.reduce((total, result) => total + result.usage.cacheHitTokens, 0)
  const cacheMissTokens = results.reduce((total, result) => total + result.usage.cacheMissTokens, 0)
  const reasoningTokens = results.reduce((total, result) => total + (result.usage.reasoningTokens ?? 0), 0)
  const latencies = results.map((result) => result.latencyMs).sort((left, right) => left - right)
  const ttfts = results.map((result) => result.ttftMs).filter((item): item is number => item !== undefined).sort((left, right) => left - right)
  const resolutionSLA = gated.length === 0 ? 1 : passed / gated.length
  const p0ResolutionSLA = p0.length === 0 ? 1 : p0Passed / p0.length
  const dimensionSLA = slaByDimension(gated)
  const pricing = defaultCachePricing()
  const effectiveCost = cacheHitTokens * pricing.inputCacheHit + cacheMissTokens * pricing.inputCacheMiss + outputTokens * pricing.output
  const resolvedTasks = results.filter((result) => result.passed).length
  const failures = results.filter((result) => !result.passed)
  const compressionCases = results.filter((result) => result.dimension === "summary_compression")
  const compressionFailures = compressionCases.filter((result) => !result.passed)
  const instructionCases = results.filter((result) => result.dimension === "system_prompt_adherence")
  const instructionFailures = instructionCases.filter((result) => !result.passed)
  const qualityGate = resolutionSLA >= 0.95 && p0ResolutionSLA === 1 ? 1 : 0
  const compositeScore = qualityGate ? 1 : 0
  const runID = `${new Date().toISOString()}-every-step-${options.provider}`
  const ignoredExpectedFields = ignoredFieldsByTask(results)
  const benchmarkDefects = results.filter((result) => result.evaluationMode === "benchmark_defect").map((result) => ({
    taskID: result.id,
    reason: result.failures.join("; ") || "case marked as benchmark_defect",
  }))
  return {
    runID,
    profile: "every-step",
    provider: options.provider,
    model: options.model ?? null,
    count: results.length,
    quality: {
      resolutionSLA,
      p0ResolutionSLA,
      dimensionSLA,
      gatedPassed: passed,
      gatedTotal: gated.length,
      hardGateTotal: gated.length,
      softOracleTotal: softOracle.length,
      ignoredExpectedFields,
    },
    benchmarkDefects,
    cost: {
      effectiveCostPerTask: results.length === 0 ? 0 : effectiveCost / results.length,
      cacheHitRatio: inputTokens === 0 ? 0 : cacheHitTokens / inputTokens,
      outputTokensPerResolvedTask: resolvedTasks === 0 ? 0 : outputTokens / resolvedTasks,
    },
    usage: {
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheMissTokens,
      reasoningTokens,
      cacheHitRatio: inputTokens === 0 ? 0 : cacheHitTokens / inputTokens,
    },
    latency: {
      p50Ms: percentile(latencies, 0.5) ?? null,
      p95Ms: percentile(latencies, 0.95) ?? null,
      ttftP50Ms: percentile(ttfts, 0.5) ?? null,
      ttftP95Ms: percentile(ttfts, 0.95) ?? null,
      totalLatencyP95Ms: percentile(latencies, 0.95) ?? null,
    },
    stability: {
      retryRate: 0,
      compressionFailureRate: compressionCases.length === 0 ? 0 : compressionFailures.length / compressionCases.length,
      instructionDriftRate: instructionCases.length === 0 ? 0 : instructionFailures.length / instructionCases.length,
    },
    apix: {
      qualityGate,
      compositeScore,
      score: qualityGate * compositeScore,
    },
    failures: failures.map((result) => ({
      taskID: result.id,
      evaluationMode: result.evaluationMode,
      cause: result.primaryCause ?? "unknown",
      reason: result.failures.join("; "),
      optimization: result.optimization ?? optimizationForCause("unknown"),
    })),
    results,
  }
}

function slaByDimension(results: APIxResult[]) {
  const groups = new Map<string, { total: number; passed: number }>()
  for (const result of results) {
    const group = groups.get(result.dimension) ?? { total: 0, passed: 0 }
    group.total += 1
    if (result.passed) group.passed += 1
    groups.set(result.dimension, group)
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([dimension, group]) => [dimension, group.total === 0 ? 1 : group.passed / group.total]))
}

function ignoredFieldsByTask(results: APIxResult[]) {
  const entries = results
    .filter((result) => result.ignoredExpectedFields.length > 0)
    .map((result) => ({ taskID: result.id, fields: result.ignoredExpectedFields }))
  return {
    count: entries.reduce((total, entry) => total + entry.fields.length, 0),
    tasks: entries,
  }
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return undefined
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))
  return values[index]
}

export function formatReport(report: ReturnType<typeof summarize>) {
  const failedByCause = new Map<string, number>()
  for (const result of report.results) {
    if (result.passed) continue
    const cause = result.primaryCause ?? "unknown"
    failedByCause.set(cause, (failedByCause.get(cause) ?? 0) + 1)
  }
  const lines = [
    `APIx eval provider=${report.provider}${report.model ? ` model=${report.model}` : ""} count=${report.count}`,
    `quality gated=${report.quality.gatedPassed}/${report.quality.gatedTotal} resolution_sla=${(report.quality.resolutionSLA * 100).toFixed(1)}%`,
    `usage input=${report.usage.inputTokens} cached=${report.usage.cacheHitTokens} miss=${report.usage.cacheMissTokens} hit_rate=${(report.usage.cacheHitRatio * 100).toFixed(1)}% output=${report.usage.outputTokens}`,
    `latency p50=${report.latency.p50Ms ?? "-"}ms p95=${report.latency.p95Ms ?? "-"}ms ttft_p50=${report.latency.ttftP50Ms ?? "-"}ms ttft_p95=${report.latency.ttftP95Ms ?? "-"}ms`,
    `failure_causes ${[...failedByCause.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([cause, count]) => `${cause}=${count}`).join(" ") || "none"}`,
    "case      pass  pri dim                         cause                     in  cache  out  ttft  latency  failures",
  ]
  for (const result of report.results) {
    lines.push(`${result.id.padEnd(9)} ${result.passed ? "yes " : "no  "} ${result.priority.padEnd(3)} ${result.dimension.padEnd(27)} ${(result.primaryCause ?? "-").padEnd(25)} ${String(result.usage.inputTokens).padStart(4)} ${String(result.usage.cacheHitTokens).padStart(6)} ${String(result.usage.outputTokens).padStart(4)} ${String(result.ttftMs ?? "-").padStart(5)} ${String(result.latencyMs).padStart(8)}  ${result.failures.join("; ")}`)
  }
  return lines.join("\n")
}
