# Changelog

## Unreleased
- Add a unified quality-gate runner plus `gate`, `verify:full`, and `verify:provider` scripts, and make `verify:v1` the default post-change gate for tests, evals, APIx subset, and cache benchmark.
- Add live `web_search` engine support with built-in Google/Brave/Tavily adapters and configurable custom JSON search engines.
- Default runtime `web_search` to implicit Google when `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` or `GOOGLE_SEARCH_ENGINE_ID` are configured.
- Add TypeScript AST scope binding to code navigation so local same-name variables do not produce false symbol references.
- Add fixture-backed `mcp_list_resources`, `mcp_read_resource`, and `web_search` tools with citation metadata and explicit retrieval permissions.
- Add opt-in `--tui` mode that reuses the existing CLI session, slash command, permission, cancellation, plan approval, timeline, and logger paths.
- Add `/sessions` to list saved interactive sessions and mark the active session.
- Add a real-provider gate command that records env, smoke eval, APIx subset, and cache benchmark results to `.easycode/reports/provider-gate`.
- Split provider HTTP/SSE plumbing from OpenAI Responses and Chat Completions-like adapters, added `openai-compatible`, and aligned JSON/max-token/cache capabilities across providers.
- Changed interactive startup without `--session` to create `default` only for empty projects and otherwise prompt for an existing or new session.
- Refined cache benchmarking to split real provider cost comparisons from deterministic adaptive controller cases, added `auto-frozen`, and changed default effective cost reporting to input-only.
