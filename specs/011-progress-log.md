# Progress Log

## Step 16: Compaction Summary Prompt Hardening

- Scope: make context-compaction summaries more production-safe by giving the summary subagent an explicit budget target, language/hypothesis preservation rules, stronger tool-noise distillation guidance, and safer malformed-output recovery.
- Implementation:
  - Expanded `src/prompt/compact.ts` so the compaction prompt now encodes role weighting, tool-output distillation, summary-language continuity, stricter summary-instruction inheritance, and a minimal `<summary>` example.
  - Added runtime prompt injection for `dynamicSummaryTokenBudget`, current active hypothesis, and latest-user language hints in `src/agent/runner.ts`.
  - Replaced the all-or-nothing summary extraction fallback with `extractCompactSummary(...)`, which recovers from fenced output, partial `<summary>` wrappers, and stray `<analysis>` blocks.
  - Added summary token telemetry to context-compaction timeline events and extended prompt/timeline/integration tests to lock the new behavior.
- Verification:
  - `bun test test/unit/prompt.test.ts test/unit/timeline.test.ts test/integration/agent.test.ts`
  - `bun run gate`
- Notes: this keeps the existing one-pass summary flow but makes the prompt contract and parser materially more robust for bilingual and tool-heavy coding sessions.

## Step 15: CLI Structure Refactor

- Scope: reduce `src/cli.ts` spaghetti by separating startup/env setup, session command handling, and line-reading primitives into dedicated modules without changing CLI behavior.
- Implementation:
  - Added `src/cli/line-reader.ts` for the readline queueing/abort mechanics so the entrypoint no longer owns low-level prompt plumbing.
  - Added `src/cli/startup.ts` for `.env` parsing/loading, provider startup configuration, live model preset lookup, and interactive Tavily/provider setup.
  - Added `src/cli/session-helpers.ts` for session selection, slash command handling, permission prompting, queued-input handling, and startup web-search hints.
  - Reduced `src/cli.ts` to the main orchestration path plus public re-exports for the existing CLI helper API used by tests.
- Verification:
  - `bun test test/unit/cli.test.ts`
  - `bun run gate`
- Notes: this slice is intentionally structural; the public CLI contract, startup prompts, slash commands, and session workflow are meant to stay unchanged while future work can target smaller modules instead of a 1k-line entrypoint.

## Step 14: Prompt Dedup Pass

- Scope: reduce repeated prompt guidance after centralization, focusing on the fixed agent prefix and duplicated selected-skill descriptions in context composition.
- Implementation:
  - Split the large agent prompt anchor into `operatingCore`, `navigationAndCacheContract`, and `symbolEditPlanContract` in `src/prompt/agent.ts` so shared rules stay explicit without repeating full symbol-planning text in multiple sections.
  - Shortened build/plan mode reminders to reference the shared symbol-aware edit-plan contract instead of restating the full checklist.
  - Changed `src/prompt/context.ts` so selected skills are no longer repeated inside the generic available-skill list; selected and unselected skills are now rendered separately.
- Verification:
  - `bun test test/unit/agent.test.ts test/unit/context.test.ts test/integration/agent.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: this pass is intended to shrink static prefix noise without changing the public runtime model or the skill-loading workflow.

## Step 13: EasyCode Summary Prompt Rewrite

- Scope: replace the borrowed Claude-style compaction summary prompt with a shorter EasyCode-native prompt and trim obvious prompt duplication now that prompt templates live under one module.
- Implementation:
  - Replaced the old compaction summary prompt example pack, `<analysis>` requirement, and long checklist with a compact EasyCode continuation-summary contract in `src/prompt/compact.ts`.
  - Added `buildCompactPrompt(...)` so summary prompt assembly stays inside the prompt module instead of being hand-built in `src/agent/runner.ts`.
  - Trimmed duplicated context prompt instructions by removing the extra `Mode:` wrapper line and shortening the repeated symbol-aware edit-plan reminder in `src/prompt/context.ts`.
- Verification:
  - `bun test test/integration/agent.test.ts test/unit/agent.test.ts test/unit/context.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: the summary subagent still returns `<summary>` payloads and keeps the same logging/compaction lifecycle; the change is about prompt quality and token discipline, not behavior surface.

## Step 12: Unified Prompt Module

- Scope: centralize EasyCode's model-facing prompt templates so agent protocol, context composition, compaction, and text-tool fallback no longer maintain separate prompt strings inline.
- Implementation:
  - Added `src/prompt/` as the shared prompt module for agent system prompts, context/system wrappers, compaction summary prompt, and text-tool protocol prompt generation.
  - Changed `src/agent/protocol.ts`, `src/context/manager.ts`, and `src/provider/text-tool-protocol.ts` to consume shared prompt builders instead of owning prompt text directly.
  - Kept `src/context/prompt.ts` as a compatibility re-export so existing imports continue to work while the source of truth moves under `src/prompt/`.
- Verification:
  - `bun test test/unit/agent.test.ts test/unit/context.test.ts test/unit/provider.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: this is a structural consolidation; prompt content and ordering are intended to remain behaviorally stable so cache-prefix expectations and existing tests keep matching.

## Step 11: Provider TLS Gate + Symbol-Aware Edit Planning

- Scope: make real-provider verification usable in TLS-constrained environments, enforce that verification during release when credentials are configured, and require symbol-aware edit planning in both build and plan mode for symbol-affecting code changes.
- Implementation:
  - Added `--insecure` / `-k` handling to `bun run verify:provider` and the underlying provider-gate CLI so real-provider checks can reuse the same TLS override path as interactive CLI sessions.
  - Updated `scripts/release.sh` to run `bun run verify:provider` automatically for any configured real providers before tagging, while still skipping explicitly when no real-provider credentials are present.
  - Added stable build/plan prompt guidance that requires symbol-aware edit planning to identify target symbols, owning definitions, affected references/callers, excluded same-name matches, and verification before symbol-affecting work.
  - Extended the shared code-exploration directive so symbol-aware edit planning is part of the normal semantic-navigation workflow rather than an ad hoc instruction.
- Verification:
  - `bun test test/unit/provider-gate.test.ts test/unit/quality-gate.test.ts test/unit/agent.test.ts test/unit/context.test.ts`
  - `bun run verify:provider -- --provider deepseek --insecure`
  - `bun run gate`
- Notes: missing provider credentials remain an explicit skip, but once credentials are present the release path now expects a passing real-provider gate before tagging.

## Step 10: Local MCP Test Server

- Scope: add a standalone local MCP stdio fixture so MCP clients can be smoke-tested from this repository without changing EasyCode's own runtime contract.
- Implementation:
  - Added `dev/mcp/test-server.ts` as a dependency-light MCP server using `Content-Length` framed JSON-RPC over stdio.
  - Exposed fixed test tools (`echo`, `sum`, `get_server_state`), resources (`sample://readme`, `sample://config`), and prompt (`summarize-change`).
  - Added `bun run mcp:test:server` plus README usage docs and a dedicated spec for the fixture contract.
  - Added an integration smoke test that spawns the server and verifies initialize, tool call, resource read, prompt get, and ping round-trips.
- Verification:
  - `bun test test/integration/mcp-test-server.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: this fixture is intentionally separate from EasyCode's `.easycode/mcp.json` retrieval path; it exists to test external MCP client behavior, not to alter current EasyCode tool loading.

## Step 9: TTY Startup Coverage + Global Tavily Setup

- Scope: cover the interactive startup branch in tests and make Tavily setup writable to the global EasyCode env instead of only hinting after startup.
- Implementation:
  - Added a test-only forced-TTY startup path so CLI tests can execute the same interactive startup branch that production uses when `stdin` is a terminal.
  - Added interactive `TAVILY_API_KEY` setup during startup and saved it to the global `~/.easycode/.env`.
  - Applied saved startup env entries back into the current process immediately, so empty-string env placeholders do not block runtime use.
  - Changed Tavily setup hints from repo-local `.env` wording to the global EasyCode env recommendation.
- Verification:
  - `bun test test/unit/cli.test.ts test/unit/retrieval.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: the new forced-TTY tests are prompt-driven instead of sleep-driven so startup coverage stays stable across multiple sequential readline prompts.

## Step 8: Provider Matrix + Startup Model Presets

- Scope: align the default real-provider gate with the public provider surface and make interactive startup model selection less guessy for DeepSeek and OpenAI.
- Implementation:
  - Changed `dev/quality/provider-gate.ts` default provider matrix from a hand-maintained pair to all public real providers (`deepseek`, `openai`, `openai-compatible`).
  - Expanded `evals/tasks/EC-REAL-001.json` so the shared real-provider smoke eval covers `openai-compatible`.
  - Added startup model discovery for `deepseek` and `openai` in `src/cli.ts`: prefer the providers' public `GET /models` APIs, keep only the two most recent versions, and still allow direct custom model input.
  - Switched OpenAI provider-specific startup config to write/read `OPENAI_MODEL` before the global `EASYCODE_MODEL` fallback.
- Verification:
  - `bun test test/unit/provider-gate.test.ts test/unit/quality-gate.test.ts test/unit/cli.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: startup provider selection now hides internal `simulated`, and provider gate defaults no longer drift from the documented supported provider surface.

## Step 6: Unified Test And Eval Gate

- Scope: consolidate typecheck, tests, fake evals, APIx, cache benchmark, build, and provider readiness behind one reportable gate entrypoint.
- Implementation:
  - Added `dev/quality/quality-gate.ts` as the shared gate runner and reporter.
  - Added `bun run gate`, `bun run verify:full`, and `bun run verify:provider` scripts.
  - Changed `bun run verify:v1` from a shell chain into the same unified gate preset.
- Verification:
  - `bun test test/unit/quality-gate.test.ts test/unit/provider-gate.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: the intended workflow is now explicit: every new requirement must clear `bun run gate` before it is considered done locally.

## Step 1: Provider Readiness Gate

- Commit: `ee7b9ac Add provider readiness gate`
- Scope: real-provider readiness command, explicit missing-credential skips, smoke/APIx/cache report generation.
- Verification:
  - `bun test`
  - `bun run typecheck`
  - `bun run provider:gate -- --provider deepseek --no-apix --no-cache`
  - `bun run eval --provider fake`
  - `bun run cache:bench -- --provider simulated --suite real --quiet`
  - `bun run build`
- Notes: full external gate was blocked by approval policy, so the recorded full-gate attempt is preserved as a failed report and the approved DeepSeek smoke gate is preserved as a passed report under `.easycode/reports/provider-gate`.

## Step 2: Usable TUI Mode

- Scope: opt-in `--tui` mode covering the same session, slash command, permission, cancellation, plan approval, timeline, and logger paths as the plain CLI.
- Specs updated:
  - `specs/000-product.md`
  - `specs/acceptance.md`
  - `specs/008-tui.md`
  - `specs/009-mcp-websearch.md`
  - `specs/010-lsp-ast.md`
- Code Complete review result:
  - Correctness: TUI reuses the existing runner and CLI control flow, avoiding a separate execution path.
  - Complexity: TUI output is isolated in `src/ui/tui.ts`; `src/cli.ts` only routes prompts/status through the optional renderer.
  - Maintainability: `--tui` is explicit and line-oriented, so normal CLI behavior and tests remain stable.
  - Verification gap found and fixed: added tests for plan approval and `--logger --tui` compatibility after the first TUI test pass.
- Verification:
  - `bun test test/unit/tui.test.ts test/unit/cli.test.ts`: 27 pass, 0 fail.
  - `bun run typecheck`: pass.
  - `bun test`: 257 pass, 2 skip, 0 fail.
  - `bun run build`: pass.
  - `bun run verify:v1`: pass; includes typecheck, 259 tests, fake eval, and cache benchmark.

## Next Target: MCP + WebSearch

- Goal: add MCP and WebSearch as dual retrieval surfaces with shared permission, citation, logging, timeout, and eval contracts.
- First implementation slice should be read-only and fixture-backed before any live network path becomes default.

## Step 3: MCP + WebSearch Retrieval Slice

- Scope: read-only MCP-style resources and WebSearch fixtures with shared source metadata.
- External research used:
  - OpenCode official docs and repository.
  - Claude Code official overview and architecture docs.
  - OpenAI Codex CLI official docs.
- Implementation:
  - `mcp_list_resources`
  - `mcp_read_resource`
  - `web_search`
  - `.easycode/mcp.json` and `.easycode/websearch.json` fixture contracts.
- Code Complete review result:
  - Correctness: fixed duplicate MCP citation generation so `source` and `sources[0]` share one timestamp.
  - Defensive behavior: added missing-fixture tests to prove retrieval tools return empty cited results instead of fabricated sources.
- Verification so far:
  - `bun test test/unit/tool.test.ts test/unit/permission.test.ts`: 42 pass, 0 fail before review fixes.
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/permission.test.ts`: 43 pass, 0 fail after review fixes.
  - `bun run verify:v1`: pass; includes typecheck, 262 tests, fake eval, and cache benchmark.
  - `bun run build`: pass.

## Step 4: LSP/AST Scope-Aware Indexing Slice

- Scope: improve TypeScript semantic indexing where text search and regex indexing are weakest.
- Advantage over current behavior:
  - Same-name function parameters and local variables no longer count as references to imported or global symbols.
  - Local indented declarations are not promoted to top-level symbols.
  - Symbol/reference lookup becomes safer for rename planning and impact analysis than plain `grep`.
- Code Complete review result:
  - Correctness: targeted a real false-positive class instead of adding broad AST complexity.
  - Complexity: kept AST logic isolated inside `code-index.ts` and preserved regex/non-TypeScript fallbacks.
  - Verification: added a same-name collision test that fails under the previous text-style reference model.
- Verification so far:
  - `bun test test/unit/code-navigator.test.ts`: 17 pass, 0 fail.
  - `bun run typecheck`: pass.
  - `bun run verify:v1`: pass; includes typecheck, 263 tests, fake eval, and cache benchmark.
  - `bun run build`: pass.

## Step 5: Live WebSearch Engine Configuration

- Scope: replace fixture-only WebSearch with real search engine support while preserving deterministic fixtures.
- External source check:
  - Brave Search API requires `X-Subscription-Token` and uses `https://api.search.brave.com/res/v1/web/search`.
  - Tavily Search API uses `POST https://api.tavily.com/search` with `Authorization: Bearer <api-key>`.
- Implementation:
  - Built-in `brave` engine with endpoint, auth header, query parameter, limit parameter, and response mapping defaults.
  - Built-in `tavily` engine with endpoint, bearer auth, JSON body, max-results, and response mapping defaults.
  - `custom` JSON engine configuration for user-provided search APIs.
  - `web_search` tool accepts `engine` and `live`; fixtures remain available with `live: false`.
- Code Complete review result:
  - Correctness: live search is config-driven and keeps fixture mode for stable tests.
  - Correctness fix: explicit unknown engines and `live: true` without an engine now fail clearly instead of silently falling back to local fixtures.
  - Resource hygiene: live request timeout timers are cleaned up after fetch completion.
  - Security: API keys are designed to come from environment variables; docs discourage committing secrets.
  - Verification: added mocked live-engine tests for Brave and custom engines, fixture fallback, missing-engine errors, and explicit live-without-engine errors.
- Verification:
  - `bun test test/unit/retrieval.test.ts test/unit/tool.test.ts test/unit/permission.test.ts`: 48 pass, 0 fail.
  - `bun run typecheck`: pass after fixing callback metrics typing in `src/cli.ts`.
  - `bun test test/unit/retrieval.test.ts test/unit/tool.test.ts test/unit/provider.test.ts test/integration/agent.test.ts`: 117 pass, 0 fail.
  - `bun run build`: pass.
  - `bun test`: 282 pass, 2 skip, 0 fail.
  - `bun run verify:v1`: pass; includes typecheck, 282 tests, fake eval, and cache benchmark.

## Step 6: Default WebSearch Engine Switched to Google

- Scope: add a built-in `google` engine and make Google the default documented live-search configuration.
- External source check:
  - Google Programmable Search JSON API uses `GET https://customsearch.googleapis.com/customsearch/v1`.
  - The request requires `q` and `cx`; API key is passed as `key`.
- Implementation:
  - Added built-in `google` engine defaults for endpoint, `q`, `num`, `items[].title`, `items[].link`, and `items[].snippet`.
  - Added generic `apiKeyParam` support so engines can send auth as a query parameter instead of an HTTP header.
  - Updated docs so the default `websearch.json` live example uses Google.
- Code Complete review result:
  - Correctness: `google` fails fast when `extraParams.cx` is missing, instead of issuing an invalid live request.
  - Maintainability: query-param auth is implemented generically rather than special-casing Google in the request path.
  - Verification: added live Google request coverage and the missing-`cx` error path.
- Verification:
  - `bun test test/unit/retrieval.test.ts test/unit/tool.test.ts test/unit/permission.test.ts`: 50 pass, 0 fail.
  - `bun run typecheck`: pass.
  - `bun run build`: pass.
  - `bun run verify:v1`: pass; includes typecheck, 284 tests, fake eval, and cache benchmark.

## Step 7: Implicit Runtime Google WebSearch Default

- Scope: remove the runtime gap where docs said Google was the default, but `web_search` still failed without an explicit engine entry.
- Implementation:
  - Runtime now injects an implicit `google` engine when `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` or `GOOGLE_SEARCH_ENGINE_ID` are present.
  - Existing configured `google` engines inherit `cx` from env when omitted in JSON.
  - The no-engine live-search error now points directly to the Google env vars needed to enable search.
- Code Complete review result:
  - Correctness: fixed the mismatch between documented default behavior and actual runtime behavior.
  - Maintainability: implicit defaults are isolated in one config-normalization helper instead of spread across request execution.
  - Verification: added no-config implicit Google coverage, env-based `cx` fill-in coverage, and more actionable error-message assertions.

## Step 8: Tavily-Only WebSearch and Startup Setup Hint

- Scope: remove Google, Brave, and custom-engine support so `web_search` exposes one supported live provider, and prompt users to configure it when interactive sessions start.
- Implementation:
  - Runtime implicit defaults now only inject `tavily` from `TAVILY_API_KEY`.
  - Non-Tavily engine entries fail with a direct Tavily-only migration error instead of partially working.
  - CLI session startup now prints a `Web Search` hint when Tavily is not configured, pointing users to the repo-root `.env` file or shell environment.
  - Tool descriptions, README, and MCP/WebSearch specs now document Tavily as the only supported live engine.
  - Removed leftover generic auth branches that only existed for non-Tavily engines.
- Code Complete review result:
  - Correctness: startup guidance closes the usability gap where `web_search` failed later without telling users where to configure it.
  - Complexity: the live-search path now has one supported provider instead of dead branches for retired providers.
  - Maintainability: docs, tool description, and runtime behavior now match; there is no longer a split between supported and merely parseable engines.
  - Verification: added CLI startup coverage for the setup hint and retained explicit unsupported-engine assertions for legacy configs.
- Verification:
  - `bun test test/unit/retrieval.test.ts test/unit/cli.test.ts`: pass.
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts`: pass.
  - `bun run verify:v1`: pass; includes typecheck, full tests, fake eval, APIx subset, and cache benchmark.
