import type { APIxCase, APIxUsage, CacheEvaluation } from "./types"

export function validateCase(task: APIxCase, output: string, usage: APIxUsage, cacheEvaluation: CacheEvaluation) {
  const failures: string[] = []
  if (task.metrics.max_output_tokens !== undefined && usage.outputTokens > task.metrics.max_output_tokens) failures.push(`output tokens ${usage.outputTokens} exceed max ${task.metrics.max_output_tokens}`)
  if (cacheEvaluation.requiredRatio !== undefined && !cacheEvaluation.eligible) {
    failures.push(`cache not eligible: ${cacheEvaluation.reason}`)
  } else if (cacheEvaluation.requiredRatio !== undefined && usage.inputTokens > 0) {
    const hitRatio = usage.cacheHitTokens / usage.inputTokens
    if (hitRatio < cacheEvaluation.requiredRatio) failures.push(`cache hit ratio ${hitRatio.toFixed(3)} below min ${cacheEvaluation.requiredRatio}`)
  }
  if (task.expected.exact !== undefined && !exactlyMatches(output, task.expected.exact)) failures.push(`expected exact ${JSON.stringify(task.expected.exact)}`)
  if (task.expected.json_schema) {
    try {
      const parsed = JSON.parse(output)
      if (task.expected.json_schema.type === "object" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) failures.push("expected JSON object")
      if (task.expected.json_schema.type === "array" && !Array.isArray(parsed)) failures.push("expected JSON array")
    } catch {
      failures.push("expected valid JSON")
    }
  }
  for (const text of task.expected.must_include ?? []) {
    if (!containsText(output, text)) failures.push(`missing ${JSON.stringify(text)}`)
  }
  if (task.expected.must_include_any?.length && !task.expected.must_include_any.some((text) => containsText(output, text))) {
    failures.push(`missing any of ${task.expected.must_include_any.map((item) => JSON.stringify(item)).join(", ")}`)
  }
  for (const text of task.expected.must_not_include ?? []) {
    if (containsText(output, text)) failures.push(`forbidden ${JSON.stringify(text)}`)
  }
  for (const source of task.expected.regex ?? []) {
    if (!new RegExp(source, "s").test(output)) failures.push(`regex did not match ${JSON.stringify(source)}`)
  }
  for (const numeric of task.expected.numeric ?? []) {
    const numbers = allNumbers(output)
    if (!numbers.some((number) => Math.abs(number - numeric.expected) <= numeric.tolerance)) failures.push(`numeric ${numeric.name} expected ${numeric.expected} got ${numbers.length ? numbers.join(",") : "none"}`)
  }
  return failures
}

export function primaryCauseFor(task: APIxCase, failures: string[], usage: APIxUsage) {
  const tracks = new Set(task.metrics.track)
  const pressures = new Set((task as { architecture_pressure?: string[] }).architecture_pressure ?? [])
  const failureText = failures.join("\n")
  if (failureText.includes("missing required fixture") || failureText.includes("provider failure")) return "resource_failure"
  if (failureText.includes("cache not eligible")) return "cache_not_eligible"
  if (isOnlyCacheFailure(failures)) return "cache_instability"
  if (failureText.includes("output tokens") || usage.outputTokens > 1_000) return "output_control"
  if (task.dimension === "needle_haystack" || pressures.has("long_context")) return "long_context_attention"
  if (task.dimension === "code_architecture" || pressures.has("code_coherence") || tracks.has("dependency_error")) return "code_context"
  if (pressures.has("code_noise") || tracks.has("code_noise_error")) return "code_context"
  if (tracks.has("instruction_drift") || task.dimension === "system_prompt_adherence" || pressures.has("instruction_adherence")) return "instruction_drift"
  if (tracks.has("active_window_loss") || task.dimension === "active_window_coreference" || pressures.has("active_window")) return "active_window_loss"
  if (tracks.has("summary_hallucination") || pressures.has("contradiction_tracking")) return "summary_hallucination"
  if (tracks.has("summary_tokens") || tracks.has("compression_count") || task.dimension === "summary_compression" || pressures.has("summary_compression")) return "summary_loss"
  if (tracks.has("conflict_policy_error") || task.dimension === "conflict_override" || pressures.has("conflict_resolution")) return "conflict_policy_error"
  if (tracks.has("hallucination_rate") || tracks.has("citation_hallucination") || pressures.has("retrieval_noise") || pressures.has("no_answer") || task.dimension === "noise_hallucination") return "retrieval_noise"
  if (task.dimension === "schema_transformation" || pressures.has("structured_transform")) return "structured_transform_error"
  if (task.dimension === "persona_creative" || tracks.has("persona_drift")) return "persona_drift"
  if (task.dimension === "edge_stress") {
    if (tracks.has("injection_success") || pressures.has("prompt_injection")) return "prompt_injection"
    if (tracks.has("continuation_error")) return "session_continuation"
    if (tracks.has("tool_calls") || tracks.has("total_latency") || pressures.has("resource_guard")) return "resource_guard"
    if (failureText.includes("expected valid JSON") || failureText.includes("regex did not match")) return "format_error"
    return "instruction_drift"
  }
  if (failureText.includes("expected valid JSON") || failureText.includes("expected JSON") || failureText.includes("regex did not match") || failureText.includes("expected exact")) return "format_error"
  if (failureText.includes("cache hit ratio") || tracks.has("cached_input_tokens") || pressures.has("stable_prefix") || pressures.has("prompt_cache")) return "cache_instability"
  return "unknown"
}

function isOnlyCacheFailure(failures: string[]) {
  return failures.length > 0 && failures.every((failure) => failure.includes("cache hit ratio"))
}

export function optimizationForCause(cause: string) {
  const optimizations: Record<string, string> = {
    instruction_drift: "Keep static rules in a stable prefix every step; pin accumulated rules into a compact rule ledger before normal history.",
    active_window_loss: "Increase activeWindowUserTurns or preserve a larger valid recent suffix; keep latest overrides outside summary compression.",
    summary_loss: "Use structured summaries with typed slots for latest facts, preferences, tasks, and entity graphs; preserve source turn numbers.",
    summary_hallucination: "Store contradictions as competing facts with timestamps instead of merging them into one synthesized statement.",
    cache_instability: "Canonicalize and sort static context, keep dynamic/RAG content after the stable prefix, and inspect every-step cache hit behavior.",
    cache_not_eligible: "Increase the stable prefix beyond the provider prompt-cache minimum or exclude this case from cache-hit gates for that provider.",
    retrieval_noise: "Add retrieval filtering, source confidence, and explicit no-answer rules before composing RAG content into the prompt.",
    conflict_policy_error: "Resolve timestamp, priority, and scope conflicts before generation; pass only the winning fact plus audit trail.",
    format_error: "Use provider-native JSON/output modes and deterministic post-validators for exact, schema, and length-constrained tasks.",
    unsupported_validator: "Move this case to soft_oracle or implement the missing deterministic validator before counting it in hard-gate SLA.",
    output_control: "Pass provider max output tokens and use concise answer contracts; treat runaway output as a context-quality failure.",
    long_context_attention: "Chunk long fixtures with anchors, add deterministic needle indexes, and place query-relevant spans in a retrieval layer.",
    structured_transform_error: "Parse structured fixtures with schema-aware helpers before asking the model to transform or summarize.",
    persona_drift: "Keep persona/style constraints in the static prefix and move creative state into a compact style ledger.",
    code_context: "Build a code-aware context ledger for symbols, versions, dependencies, and line anchors before asking for edits or diagnosis.",
    prompt_injection: "Classify escape tokens and embedded role markers as inert data before generation; preserve higher-priority instructions in the stable prefix.",
    session_continuation: "Store partial generation checkpoints with exact lexical tails so continuation requests resume from the right boundary.",
    resource_guard: "Short-circuit empty or repeated inputs and enforce tool/latency budgets before invoking expensive context assembly.",
    resource_failure: "Fail fast on missing fixtures/timeouts/tool loops, then tune context size, max steps, and fixture materialization.",
    unknown: "Inspect the case output and add a stable failure taxonomy before changing context strategy.",
  }
  return optimizations[cause] ?? optimizations.unknown
}

function containsText(output: string, expected: string) {
  return output.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
}

function exactlyMatches(output: string, expected: string) {
  return [...exactCandidates(output)].some((candidate) => candidate === expected)
}

function exactCandidates(output: string) {
  const trimmed = output.trim()
  const candidates = new Set<string>([trimmed])
  const fence = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/)
  if (fence) candidates.add(fence[1].trim())
  for (const candidate of [...candidates]) {
    const quoted = candidate.match(/^["'`](.*)["'`]$/s)
    if (quoted) candidates.add(quoted[1].trim())
  }
  return candidates
}

function allNumbers(text: string) {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter((number) => Number.isFinite(number))
}

