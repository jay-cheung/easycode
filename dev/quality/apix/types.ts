import type { ProviderName } from "../../../src/provider"

export type APIxManifest = {
  cases: APIxCase[]
}

export type APIxCase = {
  id: string
  dimension: string
  priority: "P0" | "P1" | "P2"
  evaluation_mode: "hard_gate" | "soft_oracle" | "future_capability" | "benchmark_defect"
  goal: string
  architecture_pressure?: string[]
  static_prefix?: string
  fixture: string
  turns: Array<{ role: "user" | "assistant"; content: string }>
  expected: {
    exact?: string
    json_schema?: { type?: string }
    must_include?: string[]
    must_include_any?: string[]
    must_not_include?: string[]
    aliases?: Record<string, string[]>
    regex?: string[]
    numeric?: Array<{ name: string; expected: number; tolerance: number }>
    structural?: string[]
    llm_judge_rubric?: string
    changed_files?: string[]
    forbidden_files?: string[]
  }
  metrics: {
    quality_gate: "must_pass" | "score_only"
    track: string[]
    min_cache_hit_ratio_after_warmup?: number
    require_compression?: boolean
    require_cache_comparison?: boolean
    max_output_tokens?: number
  }
}

export type APIxOptions = {
  root: string
  provider: ProviderName
  model?: string
  priority?: APIxCase["priority"]
  dimension?: string
  ids?: string[]
  limit?: number
  thinking: boolean
  maxOutputTokens?: number
  json: boolean
  table: boolean
  quiet: boolean
}

export type APIxUsage = {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  totalTokens?: number
  reasoningTokens?: number
}

export type APIxProviderRun = {
  output: string
  usage: APIxUsage
  providerFailures: string[]
  latencyMs: number
  ttftMs?: number
}

export type CacheEvaluation = {
  requiredRatio?: number
  eligible: boolean
  reason?: string
  staticPrefixTokens?: number
  minPrefixTokens?: number
}

export type APIxTrustLevel = "strict" | "assisted" | "tainted"

export type APIxTrust = {
  level: APIxTrustLevel
  reasons: string[]
}

export type APIxResult = {
  id: string
  dimension: string
  priority: APIxCase["priority"]
  evaluationMode: APIxCase["evaluation_mode"]
  goal: string
  passed: boolean
  scoreOnly: boolean
  failures: string[]
  unsupportedExpectedFields: string[]
  ignoredExpectedFields: string[]
  trust: APIxTrust
  primaryCause?: string
  optimization?: string
  rawOutput?: string
  repairAttempted?: boolean
  repairFailures?: string[]
  output: string
  usage: APIxUsage
  warmupUsage?: APIxUsage
  measuredUsage?: APIxUsage
  cacheEvaluation?: CacheEvaluation
  latencyMs: number
  ttftMs?: number
}
