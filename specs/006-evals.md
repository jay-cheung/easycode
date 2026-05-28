# Evals

## Local Eval Schema
```json
{
  "id": "EC-001",
  "mode": "build",
  "prompt": "Fix the failing test",
  "fixture": "evals/fixtures/simple-bug",
  "providers": ["fake"],
  "tools": "builtin",
  "expected": {
    "status": "passed",
    "changedFiles": ["src/add.ts"],
    "forbiddenFiles": [".env"],
    "requiredTools": ["read", "edit", "bash"],
    "maxToolCalls": 12
  }
}
```

## Initial Tasks
- `EC-001`: Fix a simple test failure.
- `EC-002`: Plan mode returns a plan and does not modify files.
- `EC-003`: Permission deny is returned as tool feedback.
- `EC-004`: `.env` read goes through permission.
- `EC-005`: Long context triggers compaction.
- `EC-006`: Skill content is progressively loaded.
- `EC-007`: Bash timeout and truncation are surfaced.
- `EC-008`: Invalid tool args can be fed back to the model.
- `EC-REAL-001`: Real provider smoke eval with no tools and output matching.

Tasks without `providers` are fake-provider deterministic evals. Real provider evals must opt in with `providers` and should avoid deterministic fake-only tool-sequence assertions unless explicitly intended.

## Cache Benchmark Contract
- Cache benchmarks support `--suite real` and `--suite all`.
- The benchmark measures the fixed every-step prompt strategy used by normal agent runs.
- Effective benchmark cost is input-only by default: cache-miss input tokens plus cached input tokens multiplied by the cached-input discount. Output tokens are reported for visibility but do not affect `effective_input` unless explicitly overridden.

## Provider Gate Contract
- `bun run provider:gate` checks `openai` and `deepseek` by default.
- `--provider <name>` narrows the gate to one provider; `--providers a,b` checks an explicit list.
- Missing required credentials are recorded as `skipped` with the missing variable names, not as pass/fail.
- Configured providers run a no-tool real smoke eval, a small deterministic APIx hard-gate subset, and the real cache benchmark unless disabled with `--no-apix` or `--no-cache`.
- Each run writes machine-readable JSON and Markdown to `.easycode/reports/provider-gate` so provider readiness can be compared over time.
- The process exits non-zero only when a configured provider check fails; an all-skipped run is allowed for local development without credentials.

## APIx Golden Dataset
- `specs/007-apix-golden-dataset.md` defines the 100-case APIx dataset for layered context architecture.
- APIx evals gate on resolution quality before comparing cost, cache, output length, latency, and stability.
- Cache hit ratio must be measured from provider usage or benchmark telemetry; it must not be inferred from answer quality alone.
- P0 APIx cases should use exact, JSON, regex, numeric, structural, or diff validators. LLM judges are reserved for P2 persona and creative-coherence cases unless paired with deterministic checks.
- APIx provider requests must use the normal context composition path and provider-native controls such as JSON response mode and output-token budgets when the case declares them.
- APIx cases that depend on long fixtures must fail fast when the fixture is missing instead of sending an under-specified prompt to a model.
