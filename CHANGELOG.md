# Changelog

## Unreleased
- Add a real-provider gate command that records env, smoke eval, APIx subset, and cache benchmark results to `.easycode/reports/provider-gate`.
- Split provider HTTP/SSE plumbing from OpenAI Responses and Chat Completions-like adapters, added `openai-compatible`, and aligned JSON/max-token/cache capabilities across providers.
- Changed interactive startup without `--session` to create `default` only for empty projects and otherwise prompt for an existing or new session.
- Refined cache benchmarking to split real provider cost comparisons from deterministic adaptive controller cases, added `auto-frozen`, and changed default effective cost reporting to input-only.
