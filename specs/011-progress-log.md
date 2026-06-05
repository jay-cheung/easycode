# Progress Log

## Step 24: Permission Friction Reduction For Readonly Retrieval

- Scope: reduce repeated approval friction for high-frequency readonly retrieval without weakening the existing dangerous-command, secret-path, or sandbox-bypass protections.
- Implementation:
  - Updated `src/permission.ts` so `web_search` is default-allowed and readonly bash auto-review now covers safe `curl` GET/HEAD fetch scopes plus project-local `cat`, `rg`, `grep`, and `sed -n` reads.
  - Updated `src/tool/bash.ts` to classify those readonly commands into narrow repeat-safe scopes, while still falling back to exact-command approval for large file reads, unsafe curl flags, or more complex command shapes.
  - Synchronized README and specs so the documented permission contract matches the runtime behavior.
- Verification:
  - `bun test test/unit/permission.test.ts test/unit/tool.test.ts`
  - `bun run typecheck`
- Notes: secret-adjacent paths like `.env*` and `secrets/**` still avoid auto-approval, and outside-path/native-sandbox bypasses still require an explicit risk prompt.

## Step 23: Immediate Provider Wait State After Tool Completion

- Scope: remove the misleading “工具已完成” stall after a tool returns by surfacing the next provider-wait state immediately, without adding extra waiting spam to the timeline transcript.
- Implementation:
  - Updated `src/agent/runner.ts` so each provider turn emits an immediate `provider_progress` event with `elapsedMs: 0` before the timed progress loop starts.
  - Updated `src/ui/timeline.ts` to treat that zero-elapsed wait event as status-only, so the TUI panel refreshes while the textual timeline stays quiet.
  - Added `test/unit/runner.test.ts` to lock the event ordering after a successful `skill` tool result.
- Verification:
  - `bun test test/unit/runner.test.ts test/unit/tui.test.ts test/unit/timeline.test.ts`
- Notes: this change does not alter provider/tool execution semantics; it only fixes the handoff state the user sees between tool completion and the next model turn.

## Step 22: TUI Helper Extraction

- Scope: execute Phase 1 of the readability roadmap by shrinking `src/ui/tui.ts` into a clearer renderer façade while preserving the existing TUI contract and timeline behavior.
- Implementation:
  - Added `src/ui/tui-types.ts` for shared TUI context/output types.
  - Added `src/ui/tui-ansi.ts` for width, truncation, card, duration, and newline helpers that were previously embedded in `tui.ts`.
  - Added `src/ui/tui-cards.ts` for configured/session/welcome/success/failure card construction.
  - Added `src/ui/tui-status-panel.ts` for live monitor line generation and spinner-frame ownership.
  - Reduced `src/ui/tui.ts` so it focuses on state transitions, event handling, prompt status, and output orchestration instead of also owning the full rendering helper stack.
- Verification:
  - `bun test test/unit/tui.test.ts test/unit/timeline.test.ts`
  - `bun test test/unit/cli.test.ts`
  - `bun run gate`
- Notes: this slice is intentionally structural; `RunUiEvent`, prompt strings, TUI interaction flow, and session/timeline wiring are intended to remain behaviorally stable.

## Step 21: Singular XML Tool-Call Fallback

- Scope: recover tool execution when a model prints a single `<tool_call>...</tool_call>` wrapper instead of native tool calls, and suppress that wrapper from the visible TUI stream.
- Implementation:
  - Extended `src/provider/text-tool-protocol.ts` to parse singular XML wrappers that carry `<invoke_name>` plus nested `<args>` tags, including the observed `bash` + `<invoke>` command shape.
  - Added stream-filter coverage for singular `<tool_call>` blocks so raw wrapper markup no longer leaks into live text deltas before fallback extraction runs.
  - Added unit and integration coverage for the exact wrapper family that previously rendered verbatim instead of executing.
- Verification:
  - `bun test test/unit/provider.test.ts test/integration/agent.test.ts`
  - `bun run typecheck`
  - `bun run gate`
- Notes: this change is intentionally additive; the existing EasyCode text protocol, Anthropic-style XML fallback, and DSML variants remain unchanged.

## Step 20: TUI UI Language Selection

- Scope: localize fixed interactive CLI/TUI copy across six languages and add durable language selection at first startup plus a `/lang` session command.
- Implementation:
  - Added `src/i18n.ts` as the shared fixed-copy catalog for `en`, `zh`, `ja`, `fr`, `ko`, and `de`, covering slash help, session/setup prompts, TUI panels, live monitor status text, and timeline headings.
  - Extended `SessionSettings` with persisted `language`, wired startup to prompt for `EASYCODE_LANG` on first interactive launch, and saved the chosen default into `~/.easycode/.env`.
  - Added `/lang <code>` handling so the current session, future startup defaults, and TUI rendering can all switch languages without restarting the app.
  - Updated CLI/TUI tests to cover first-start language setup, `/lang` persistence, and the localized startup/web-search flow.
- Verification:
  - `bun test test/unit/slash.test.ts test/unit/session.test.ts test/unit/tui.test.ts test/unit/cli.test.ts`
  - `bun run typecheck`
- Notes: runtime/model/tool error strings outside the fixed TUI/session surface remain unchanged for now; this slice targets user-facing shell copy and startup/session UX.

## Step 19: Single Unified Gate

- Scope: collapse the public verification surface to one `bun run gate` command and make it include the former full gate plus real-provider checks by default.
- Implementation:
  - Simplified `dev/quality/quality-gate.ts` to a single fixed check plan: typecheck, tests, fake eval, simulated APIx subset, simulated cache benchmark, build, and provider readiness.
  - Removed public `gate:full`, `gate:provider`, `test:real`, `eval:real`, and `apix:real` scripts from `package.json`.
  - Updated `scripts/release.sh`, README, acceptance criteria, and eval spec so the repo now documents one gate vocabulary and one release verification entrypoint.
- Verification:
  - `bun test test/unit/quality-gate.test.ts test/unit/provider-gate.test.ts`
  - `bun run gate`
- Notes: the provider-gate implementation still exists internally, but it is now only an engine behind the unified gate instead of a separate public workflow.

## Step 18: Readability Refactor Roadmap

- Scope: convert the readability discussion into a repo-grounded structural-refactor plan that improves code navigation, sequencing, and verification discipline without changing runtime behavior.
- Implementation:
  - Added `specs/014-readability-refactor-roadmap.md` as the source-of-truth plan for phased readability and architecture cleanup.
  - Documented the current hotspot modules, target module boundaries, refactor ordering, per-phase risks, and required verification gates.
  - Captured the rule that each structural slice remains single-theme, updates the progress log, and runs `bun run gate`.
- Verification:
  - Reviewed current hotspot files and current `specs/` structure to ground the roadmap in the existing repo layout and constraints.
- Notes: this step is planning-only by design; it is intended to reduce future refactor risk and keep architecture work behavior-preserving rather than to change runtime semantics directly.

## Step 17: Gate Command Cleanup

- Scope: remove stage-specific verification aliases from the public CLI surface and make the repo speak one gate vocabulary consistently.
- Implementation:
  - Reduced `package.json` gate entrypoints to `bun run gate`, `bun run gate:full`, and `bun run gate:provider`.
  - Updated `scripts/release.sh` to use the unified gate names for local and real-provider verification before tagging.
  - Synchronized README and current specs so they no longer advertise `verify:v1`, `verify:full`, `verify:provider`, or the separate `provider:gate` entrypoint.
- Verification:
  - `bun run gate`
  - `bun run gate:full`
  - `bun run gate:provider -- --provider fake --no-apix --no-cache`
- Notes: the underlying quality-gate presets and provider-gate implementation remain intact; only the public command surface was simplified.

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

## Step 9: TUI Helper Extraction

- Scope: break `src/ui/tui.ts` into smaller UI-focused modules without changing the public TUI flow or `RunUiEvent` handling contract.
- Implementation:
  - Extracted shared TUI types into `src/ui/tui-types.ts`.
  - Extracted ANSI and width helpers into `src/ui/tui-ansi.ts`.
  - Extracted welcome/status/summary card builders into `src/ui/tui-cards.ts`.
  - Extracted status-panel line generation into `src/ui/tui-status-panel.ts`.
  - Reduced `src/ui/tui.ts` to orchestration, event handling, and output coordination.
- Code Complete review result:
  - Correctness: rendering contracts stayed inside the existing `TuiRenderer` facade, so CLI and timeline callers did not need behavior changes.
  - Maintainability: card layout, ANSI helpers, and panel rendering can now evolve independently instead of sharing one 600+ line file.
  - Verification: preserved existing TUI/timeline assertions rather than replacing them with looser snapshots.
- Verification:
  - `bun test test/unit/tui.test.ts test/unit/timeline.test.ts`: pass.
  - `bun test test/unit/cli.test.ts`: pass.
  - `bun test`: pass.

## Step 10: TUI Runtime State Isolation + Gate Env Cleanup

- Scope: keep Phase 1 moving by extracting TUI runtime state transitions, then fix the quality gate so test runs do not inherit global EasyCode runtime configuration.
- Implementation:
  - Added `src/ui/tui-state.ts` to hold run lifecycle state such as streaming, prompt-paused mode, spinner frame, elapsed timing, queued input, and provider metrics.
  - Simplified `src/ui/tui.ts` so it delegates run-state transitions to `TuiState` and stays focused on rendering orchestration.
  - Updated `src/cli/startup.ts` so global `~/.easycode/.env` loading can be disabled explicitly with `EASYCODE_DISABLE_GLOBAL_ENV=1`.
  - Updated `dev/quality/quality-gate.ts` so the `tests` check runs with a sanitized env and does not inherit provider/search config from the global EasyCode env file.
  - Added CLI coverage for the explicit global-env skip path in `test/unit/cli.test.ts`.
- Code Complete review result:
  - Correctness: gate test runs now behave like direct `bun test`, instead of silently depending on machine-local provider env.
  - Maintainability: `TuiRenderer` no longer owns both state machine data and rendering details, which lowers the risk of future TUI edits.
  - Verification: quality-gate divergence was validated by fixing the env boundary and then re-running the full gate.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tui.test.ts test/unit/timeline.test.ts test/unit/cli.test.ts`: 53 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 11: Builtin Tool Registry Family Split

- Scope: reduce `src/tool/builtins.ts` from a single long registration file into focused family modules without changing any tool names, input schemas, permissions, or runtime behavior.
- Implementation:
  - Kept `createBuiltinRegistry()` as the only public entrypoint in `src/tool/builtins.ts`.
  - Split filesystem/code navigation tools into `src/tool/builtins/code-tools.ts`.
  - Split git workflow tools into `src/tool/builtins/git-tools.ts`.
  - Split edit/bash/memory/connector tools into `src/tool/builtins/workspace-tools.ts`.
  - Split MCP/web search/skill/plan tools into `src/tool/builtins/retrieval-tools.ts`.
  - Centralized small shared schema helpers in `src/tool/builtins/common.ts`.
- Code Complete review result:
  - Correctness: registration order and tool contracts stayed stable because the public registry constructor still wires the same definitions into one `ToolRegistry`.
  - Maintainability: adding or auditing a tool family no longer requires editing a 500+ line mixed-responsibility file.
  - Verification: focused regression coverage was kept at the registry/tool/provider layer so the move stayed behavior-preserving rather than snapshot-driven.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.

## Step 12: Runner Provider-Turn And Background Task Split

- Scope: start decomposing `src/agent/runner.ts` by extracting low-risk orchestration-adjacent responsibilities while keeping the main run loop behavior stable.
- Implementation:
  - Extracted provider stream consumption, XML-safe delta replay, fallback text-to-tool-call parsing, and provider progress handling into `src/agent/provider-turn.ts`.
  - Extracted background summary compaction task creation/execution into `src/agent/summary-subagent.ts`.
  - Extracted repo-map prewarm and query-targeted repo-map ledger/event updates into `src/agent/repo-map-refresh.ts`.
  - Kept hypothesis validation and the top-level run loop in `runner.ts`, so this slice changed structure without rewriting core step semantics.
- Code Complete review result:
  - Correctness: provider replay events, cancellation behavior, summary compaction, and repo-map warmup stayed behind the same `AgentRunner` call sites.
  - Maintainability: `runner.ts` now focuses more on orchestration and less on embedded IO/event helper logic.
  - Verification: validated at provider, tool, context, and runner layers after each extraction step instead of relying on one broad smoke test.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 13: Runner Tool Execution And Hypothesis Side-Effect Split

- Scope: continue shrinking `runner.ts` by moving tool-execution plumbing and hypothesis/intent ledger side effects behind focused helpers, without changing tool loop order or ledger semantics.
- Implementation:
  - Extracted tool execution, bash progress timing, tool-result UI event emission, and tool outcome ledger updates into `src/agent/tool-execution.ts`.
  - Extracted active hypothesis hydration/messages, hypothesis drift ledger updates, run-intent ledger setup, and shared ledger string helpers into `src/agent/hypothesis-state.ts`.
  - Rewired `runner.ts` to call those helpers while preserving the same tool loop, hypothesis discipline checks, and cancellation paths.
- Code Complete review result:
  - Correctness: tool result ordering, plan-exit handling, and hypothesis correction prompting stayed in the same run-loop sequence.
  - Maintainability: `runner.ts` no longer mixes orchestration with repetitive ledger-side-effect construction and tool-progress boilerplate.
  - Verification: repeated the same focused regression set and full gate after each extraction to catch structural drift early.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 14: Runner Support Helper Split

- Scope: remove the remaining low-level settings and mode/permission helper logic from `runner.ts` so the class focuses more narrowly on orchestration.
- Implementation:
  - Extracted selected-skill resolution, pending-skill filtering, skill-load bookkeeping, effective plan/build mode switching, and permission-service mode selection into `src/agent/runner-support.ts`.
  - Kept the existing `AgentRunner` call sites and return shapes unchanged, so the move is structural rather than behavioral.
- Code Complete review result:
  - Correctness: skill selection, plan approval mode switching, and permission rule reuse still flow through the same run loop decisions.
  - Maintainability: runner support logic is now isolated from the main execution class, which makes future policy changes easier to review independently.
  - Verification: reran the same focused provider/tool/context/runner suite and full gate after the extraction.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 15: Runner Validation Loop And Helper Extraction

- Scope: keep shrinking `src/agent/runner.ts` by moving the hypothesis-validation retry loop and trailing pure helper functions into focused support modules, without changing run-loop semantics.
- Implementation:
  - Extracted validated provider-turn retry and hypothesis-correction orchestration into `src/agent/validated-provider-turn.ts`.
  - Extracted pure helper functions for failure text shaping, assistant message assembly, exploration checkpoint prompts, compact-summary prompt building, and summary-language hinting into `src/agent/runner-helpers.ts`.
  - Rewired `runner.ts` to delegate to those helpers while preserving the same event emission, hypothesis discipline, and context-compaction behavior.
- Code Complete review result:
  - Correctness: provider-turn validation still retries at most once, emits the same replayed output, and returns the same synthetic failure when hypothesis drift remains unresolved.
  - Maintainability: `runner.ts` is now closer to a lifecycle/orchestration class instead of carrying policy-neutral text and prompt helper utilities inline.
  - Verification: reran the focused runner/provider/context/tool suite after each extraction step, then revalidated through the unified local gate.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 16: Context Manager Helper Split

- Scope: reduce `src/context/manager.ts` by moving pure cache-window, prefix-budget, and summary truncation helpers into a dedicated support module, without changing any context composition or compaction behavior.
- Implementation:
  - Extracted `WindowStats` plus static-prefix sizing, cache-window accumulation, strategy cloning, effective window cost, and summary token-budget truncation helpers into `src/context/manager-helpers.ts`.
  - Kept `ContextManager` state transitions and budgeting decisions unchanged; the class now delegates to the helper module for pure calculations.
  - Fixed an intermediate import regression during the extraction by sourcing `estimateTextTokens` from `src/context/tokens.ts`, then reran the same focused suite to re-establish a clean baseline.
- Code Complete review result:
  - Correctness: planning, cache accounting, and summary truncation still use the same formulas and thresholds because only the function location changed.
  - Maintainability: `ContextManager` now keeps mutation and policy logic local while moving calculation-only helpers into a dedicated file that can be reused or reviewed independently.
  - Verification: validated the structural move with focused provider/tool/context/runner tests after fixing the helper import issue, then re-ran the unified local gate.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 17: Instrumentation Provider Logging Split

- Scope: reduce `src/instrumentation.ts` by extracting provider-specific logging, transcript rendering, cache-hit markup, and provider-error shaping helpers into a focused module, without changing `RunAspect` behavior.
- Implementation:
  - Added `src/instrumentation-provider.ts` for provider input token estimation, usage normalization, provider event logging, transcript emission, cache-hit input marking, raw response error detection, and provider error detail formatting.
  - Rewired `LoggingRunAspect.instrumentProvider()` to delegate to those helpers while keeping the same emitted log event names and detail shapes.
  - Fixed an intermediate regression where `ProviderError` was no longer imported in `src/instrumentation.ts`, then reran the focused suite to restore a clean baseline.
- Code Complete review result:
  - Correctness: provider transcript logging, usage logging, and provider error shaping still run at the same stream lifecycle points because only the helper location changed.
  - Maintainability: `instrumentation.ts` now keeps the aspect wrappers and control flow visible while moving provider-formatting noise into a dedicated helper file.
  - Verification: reran the focused provider/tool/context/runner suite after the import fix, then revalidated through the unified local gate.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 18: Instrumentation Context Decorator Split

- Scope: finish the low-risk `instrumentation` decomposition by extracting the logging context decorator and its snapshot helpers into a dedicated module, without changing any emitted context log event names or detail shapes.
- Implementation:
  - Added `src/instrumentation-context.ts` for `LoggingContextDecorator`, context snapshot capture, and ledger detail formatting.
  - Rewired `LoggingRunAspect.instrumentContext()` to instantiate the extracted decorator while leaving `RunAspect` and logger usage unchanged.
  - Kept `instrumentation.ts` focused on the `RunAspect` interface plus the `LoggingRunAspect` orchestration shell.
- Code Complete review result:
  - Correctness: context add/ledger/compaction/compose logging still occurs at the same wrapper methods because only the decorator definition moved.
  - Maintainability: `instrumentation.ts` is now a small aspect assembly file, while provider logging and context logging each live in their own focused modules.
  - Verification: reran the focused provider/tool/context/runner suite after the extraction, then revalidated through the unified local gate.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tool.test.ts test/unit/provider.test.ts test/unit/context.test.ts test/unit/runner.test.ts`: 111 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 19: Retrieval Formatting And Ranking Helper Split

- Scope: start decomposing `src/retrieval.ts` by extracting pure citation, formatting, ranking, and result-limit helpers into a dedicated module, without changing MCP or web-search service behavior.
- Implementation:
  - Added `src/retrieval-format.ts` for MCP/web citations, MCP/web result formatting, resource/result ranking, and limit clamping.
  - Re-exported the existing public formatting and citation helpers from `src/retrieval.ts` so tool-call sites and tests keep the same import contract.
  - Kept live request construction, engine normalization, and config loading inside `src/retrieval.ts` for this first low-risk slice.
- Code Complete review result:
  - Correctness: citations, formatted output strings, ranking order, and result limits still use the same logic because only helper locations changed.
  - Maintainability: `retrieval.ts` now holds the service and engine-flow logic while pure presentation/scoring helpers live in an isolated module that is easier to extend or test independently.
  - Verification: validated with retrieval, tool, and CLI startup coverage because those paths exercise both fixture ranking and the Tavily setup hint behavior.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/retrieval.test.ts test/unit/tool.test.ts test/unit/cli.test.ts`: 79 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 20: Retrieval Live Engine Helper Split

- Scope: continue decomposing `src/retrieval.ts` by extracting live-engine normalization, auth/header shaping, request building, timeout wiring, and result parsing helpers into a dedicated module, without changing Tavily-only runtime behavior.
- Implementation:
  - Added `src/retrieval-live.ts` for engine normalization, API key lookup, header shaping, request assembly, response parsing, and timeout cleanup.
  - Rewired `WebSearchService.searchLive()` to delegate to those helpers while preserving the same TLS injection, fetch behavior, and error messages.
  - Fixed an intermediate regression where the unsupported-engine path lost the Tavily setup hint because `normalizeEngine()` was called without the shared hint string.
- Code Complete review result:
  - Correctness: live request construction and parsing still happen in the same order and produce the same Tavily-only behavior because the helper extraction kept the same defaults and error text.
  - Maintainability: `retrieval.ts` now concentrates on service flow and config loading, while live-engine mechanics live in an isolated module that is easier to reason about and test independently.
  - Verification: validated with retrieval, tool, and CLI startup coverage because those paths exercise unsupported-engine errors, Tavily setup hints, live-search config checks, and tool-surface formatting.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/retrieval.test.ts test/unit/tool.test.ts test/unit/cli.test.ts`: 79 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 21: Retrieval Config Helper Split

- Scope: finish the low-risk `retrieval` decomposition by extracting engine selection and implicit Tavily default resolution helpers into a dedicated config module, without changing startup hints or runtime engine resolution.
- Implementation:
  - Added `src/retrieval-config.ts` for `selectEngine()` and `withImplicitDefaults()`.
  - Rewired `src/retrieval.ts` to pass `WebSearchEngine.parse` through the helper so implicit Tavily engine injection keeps the same schema validation behavior.
  - Fixed two intermediate regressions during the extraction:
    - the parser callback was initially omitted, which broke the implicit Tavily default path;
    - the helper return type initially dropped `results`, so it was widened to preserve the full config shape.
- Code Complete review result:
  - Correctness: default-engine selection, implicit Tavily injection, and configured-engine lookup still behave the same because the helper keeps the same validation and selection rules.
  - Maintainability: `retrieval.ts` now focuses on service flow and file IO, while config resolution, live request mechanics, and formatting are each isolated in their own modules.
  - Verification: reran retrieval, tool, and CLI startup coverage after fixing both regressions, since those paths exercise implicit Tavily setup, engine lookup, and user-facing setup hints.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/retrieval.test.ts test/unit/tool.test.ts test/unit/cli.test.ts`: 79 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 22: Context Compose And Compaction Snapshot Split

- Scope: continue shrinking `src/context/manager.ts` by extracting message-composition and compaction-snapshot assembly helpers into a focused module, without changing budgeting or context-selection behavior.
- Implementation:
  - Added `src/context/manager-compose.ts` for provider-message assembly and compaction snapshot construction.
  - Rewired `ContextManager.compose()` and `ContextManager.compactionSnapshot()` to delegate to those helpers while preserving the same prompt ordering, summary wrapping, and protected-tool-result redaction.
  - Kept budget math, cache accounting, ledger selection, and mutation logic inside `ContextManager` so this slice stayed on the pure data-transformation boundary.
- Code Complete review result:
  - Correctness: compose ordering, summary inclusion, skill/instruction prompt assembly, and compaction snapshot redaction still use the same logic because the extracted helpers are pure reorganizations of the previous implementation.
  - Maintainability: `ContextManager` now focuses more on strategy, mutation, and budgeting, while message-assembly responsibilities live in a dedicated helper file with direct context-test coverage.
  - Verification: reran context, runner, and tool coverage because these paths exercise compose ordering, compaction snapshots, and provider-facing prompt composition.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/context.test.ts test/unit/runner.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 23: Context Stats And Ledger Calculation Split

- Scope: continue decomposing `src/context/manager.ts` by extracting cache stats, budget stats, compaction-basis, and ledger-selection calculations into a focused helper module, without changing context mutation behavior.
- Implementation:
  - Added `src/context/manager-stats.ts` for cache/budget stats, compaction basis, ledger token budget, selected ledger rendering, and ledger stats calculation.
  - Rewired `ContextManager.selectedLedgerText()`, `cacheStats()`, `budgetStats()`, `compactionBasis()`, `ledgerStats()`, and `ledgerTokenBudget()` to delegate to those pure helpers.
  - Kept message mutation, compaction application, and strategy state transitions inside `ContextManager`, so this slice stayed on the read-only calculation boundary.
- Code Complete review result:
  - Correctness: cache metrics, budget reporting, and ledger selection still use the same formulas and selection rules because the extracted helpers preserve the previous logic exactly.
  - Maintainability: `ContextManager` is now more focused on owned state transitions, while stats and ledger math live in a dedicated helper that can be reasoned about independently.
  - Verification: reran context, runner, and tool coverage because those paths exercise ledger rendering, cache stats, and provider-facing budgeting behavior.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/context.test.ts test/unit/runner.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 24: Context Compaction Application Split

- Scope: keep shrinking `src/context/manager.ts` by extracting the repeated compaction-application logic behind `compact()` and `compactSnapshot()` into a focused helper module, without changing compaction eligibility or conflict recording semantics.
- Implementation:
  - Added `src/context/manager-compaction.ts` for full compaction result creation and snapshot-based compaction result creation.
  - Rewired `ContextManager.compact()` and `ContextManager.compactSnapshot()` to delegate to those helpers while preserving summary truncation, preserved-message selection, and ledger conflict generation.
  - Fixed an intermediate type regression by normalizing the optional ledger before passing it to `summaryLedgerConflicts()`.
- Code Complete review result:
  - Correctness: compaction still keeps the same preserved suffix and summary-conflict behavior because the extracted helpers are direct reorganizations of the previous logic.
  - Maintainability: `ContextManager` now centers more on mutation and strategy orchestration, while compaction result construction is isolated in its own helper file.
  - Verification: reran context, runner, and tool coverage because those paths exercise both direct compaction and snapshot-based background compaction behavior.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/context.test.ts test/unit/runner.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 25: Runner Terminal Outcome Helper Split

- Scope: start another low-risk `runner` slice by extracting terminal outcome helpers for run completion signaling and cancellation-result assembly, without changing main-loop decision order.
- Implementation:
  - Added `src/agent/runner-outcomes.ts` for `run_done` event emission and cancelled run result assembly.
  - Rewired `AgentRunner.cancelledResult()` and `AgentRunner.emitRunDone()` to delegate to the helper module while preserving the same context append, state transition, and provider-metrics event behavior.
  - Kept provider failure, tool loop, and completion decisions inline in `runner.ts`, so this slice only moved end-of-run packaging responsibilities.
- Code Complete review result:
  - Correctness: cancellation still emits the same failure text, appends the same assistant message, and transitions through the same `cancelled` state because the helper is a direct extraction of the previous logic.
  - Maintainability: terminal outcome shaping now has an isolated home instead of living inline beside the main run loop.
  - Verification: reran runner, context, and tool coverage because these paths exercise cancellation, `run_done`, and immediate post-tool streaming transitions.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/runner.test.ts test/unit/context.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 26: Runner Turn Preparation Helper Split

- Scope: continue the low-risk `runner` decomposition by extracting per-step provider-turn preparation logic, without changing tool-loop order or summary-readiness policy.
- Implementation:
  - Added `src/agent/runner-turn-prep.ts` for composing `planRequest()` output, summary-readiness gating, active-hypothesis system messages, and the resulting provider message/tool set for each step.
  - Rewired the main run loop to call the helper instead of assembling `providerMessages` and `availableTools` inline.
  - Kept turn execution, tool running, and terminal branching inside `runner.ts`, so this slice stayed on the preflight preparation boundary.
- Code Complete review result:
  - Correctness: summary-readiness checkpoints, active-hypothesis message injection, and tool disabling on late exploration steps still happen under the same conditions because the helper is a direct extraction of the previous inline logic.
  - Maintainability: the run loop now reads more clearly as `prepare -> stream -> handle outcome -> run tools`, instead of mixing prompt assembly with execution flow.
  - Verification: reran runner, context, and tool coverage because these paths exercise step preparation, plan-mode messaging, and immediate post-tool transitions.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/runner.test.ts test/unit/context.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 27: Session Tail Policy Split

- Scope: address the remaining explicit Phase 4 session-policy gap by extracting persisted session tail selection rules out of `src/session.ts`, without changing session file shape or restore behavior.
- Implementation:
  - Added `src/session-tail.ts` for persisted-tail selection, recent session suffix selection, and greedy fallback suffix logic.
  - Rewired `SessionStore.save()` and `SessionStore.context()` to delegate to `persistedSessionMessages()` from the new module.
  - Kept `SessionStore` responsible only for filesystem persistence, normalization, and restore orchestration.
- Code Complete review result:
  - Correctness: persisted session save/restore still keeps the latest answered turn, preserves unanswered latest user turns, and avoids orphan leading tool results because the extracted helpers preserve the previous tail-selection logic exactly.
  - Maintainability: session-tail policy is now explicit and independently testable, instead of being buried inside the persistence class.
  - Verification: reran session, context, and CLI coverage because those paths exercise persisted-tail save/restore behavior, startup restore, and cancellation/session persistence interactions.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/session.test.ts test/unit/context.test.ts test/unit/cli.test.ts`: 89 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 28: Context Strategy Helper Split

- Scope: continue filling the explicit Phase 4 boundary map by extracting `ContextManager` strategy defaults, initialization, and clamping logic into a dedicated strategy helper, without changing budget semantics.
- Implementation:
  - Added `src/context/strategy.ts` for min token floor calculation, initial max-token selection, response reserve defaults, safety multiplier defaults, initial strategy state creation, and strategy-state clamping.
  - Rewired `ContextManager` construction and `applyStrategy()` to delegate to those helpers while preserving the same clamped values and default budgets.
  - Kept runtime state mutation and budgeting orchestration in `ContextManager`, so this slice stayed on the pure policy/helper boundary.
- Code Complete review result:
  - Correctness: default token budgets, response reserve sizing, safety multiplier clamping, and `configureStrategy()` behavior still follow the same formulas because the helper extraction preserves the previous values exactly.
  - Maintainability: strategy policy is now explicit instead of being embedded in the manager constructor, which aligns more directly with the roadmap’s `context/strategy` separation goal.
  - Verification: reran context, session, and runner coverage because these paths exercise initial context defaults, strategy reconfiguration, and persisted-session restore under the current budgets.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/context.test.ts test/unit/session.test.ts test/unit/runner.test.ts`: 50 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 29: Runner Failure Policy Boundary Extraction

- Scope: materialize the roadmap’s explicit `failure-policy` boundary by moving runner failure-text shaping into its own module, without changing terminal behavior or tool-loop order.
- Implementation:
  - Added `src/agent/failure-policy.ts` for `runFailureText()`.
  - Rewired `runner.ts` to import failure text shaping from the new module instead of keeping it inside the generic helper bundle.
  - Left terminal outcome assembly in `runner-outcomes.ts` and the main branching logic in `runner.ts`, so this slice stayed narrowly structural.
- Code Complete review result:
  - Correctness: provider-error and max-step failure text still append the same guidance because the helper is a direct move of the previous implementation.
  - Maintainability: failure semantics now have an explicit home that matches the roadmap, instead of living inside a mixed helper file.
  - Verification: reran runner, context, and tool coverage because these paths exercise provider failure text, cancellation-adjacent terminal paths, and max-step handling.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/runner.test.ts test/unit/context.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 30: Runner Events Boundary Extraction

- Scope: materialize the roadmap’s explicit `runner-events` boundary by moving small but reusable runner event emitters into a dedicated module, without changing event order.
- Implementation:
  - Added `src/agent/runner-events.ts` for `run_done` emission with provider-metrics bridging and plan-exit text emission.
  - Rewired `runner.ts` and `runner-outcomes.ts` to use the extracted event helpers.
  - Fixed an intermediate import regression where `runner.ts` still imported `emitRunDoneEvent` from the old module after the move.
- Code Complete review result:
  - Correctness: `run_done`, provider-metrics final emission, and plan-exit text deltas still fire in the same order because the extracted helpers preserve the previous call sites exactly.
  - Maintainability: the named event-boundary from the roadmap now exists explicitly instead of being spread across `runner.ts` and outcome helpers.
  - Verification: reran runner, context, and tool coverage because these paths exercise immediate post-tool event emission, cancellation completion, and plan-exit text behavior.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/runner.test.ts test/unit/context.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 31: TUI Render Loop Split

- Scope: keep thinning the remaining thick TUI façade by extracting panel redraw/erase and timeline-text write-loop plumbing into a dedicated helper module, without changing TTY rendering behavior.
- Implementation:
  - Added `src/ui/tui-render-loop.ts` for status-panel erase/draw, panel-aware text writes, timeline writes, and welcome/success/failure summary card rendering.
  - Rewired `src/ui/tui.ts` to delegate its redraw plumbing to the new helper while preserving `TuiState` ownership and event semantics.
  - Kept `event(...)`, prompt entrypoints, and high-level TUI orchestration inside `TuiRenderer`, so this slice stayed on the rendering-plumbing boundary.
- Code Complete review result:
  - Correctness: timeline writes, panel redraw suppression, spinner-driven updates, and summary-card rendering still happen at the same call sites because the helper extraction preserved the same control flow.
  - Maintainability: `tui.ts` now focuses more on event handling and user-facing prompts instead of mixing that with low-level redraw mechanics.
  - Verification: reran TUI, timeline, and CLI coverage because those paths exercise permission prompts, plan approval prompts, panel redraws, session rendering, and non-TTY compatibility.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tui.test.ts test/unit/timeline.test.ts test/unit/cli.test.ts`: 57 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 32: Agent Runner Directory Consolidation

- Scope: improve the `src/agent` file structure by grouping the already-extracted runner collaborators under a dedicated `src/agent/runner/` directory, without changing the exported `src/agent` surface or runner behavior.
- Implementation:
  - Moved `runner.ts` into `src/agent/runner/index.ts` so `src/agent/index.ts` can keep exporting `./runner` as the same public entrypoint.
  - Moved runner-only collaborators into the same directory: `provider-turn`, `repo-map-refresh`, `runner-events`, `runner-helpers`, `runner-outcomes`, `runner-support`, `runner-turn-prep`, `summary-subagent`, `tool-execution`, `validated-provider-turn`, `failure-policy`, and `hypothesis-state`.
  - Rewired relative imports so shared agent primitives stay at `src/agent/*`, while runner-internal modules resolve locally from `src/agent/runner/*`.
- Code Complete review result:
  - Correctness: this is a directory-boundary change only; the `AgentRunner` API, `src/agent` barrel export, and runner/tool/context behavior are preserved because module contents and call sites stayed the same.
  - Maintainability: `src/agent` now separates shared agent primitives from the runner subsystem, making the module tree match the architecture that had already emerged in code.
  - Verification: reran typecheck, runner/context/tool coverage, and the unified gate because this slice changes many import paths and the `src/agent` export surface.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/runner.test.ts test/unit/context.test.ts test/unit/tool.test.ts`: 69 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 33: TUI Directory Consolidation

- Scope: improve the `src/ui` file structure by grouping the already-extracted TUI collaborators under a dedicated `src/ui/tui/` directory, without changing the exported `src/ui/tui` entrypoint or runtime behavior.
- Implementation:
  - Moved `src/ui/tui.ts` into `src/ui/tui/index.ts` so existing imports of `../ui/tui` continue resolving through the directory entrypoint.
  - Moved TUI-only collaborators into the same directory: `tui-ansi`, `tui-cards`, `tui-render-loop`, `tui-state`, `tui-status-panel`, and `tui-types`.
  - Rewired relative imports so TUI internals reference shared `timeline`, `i18n`, `session`, and `permission` modules through stable parent paths.
  - Updated TUI unit tests to import from the new `src/ui/tui/*` locations.
- Code Complete review result:
  - Correctness: this is a directory-boundary change only; the `TuiRenderer` API and `src/ui/tui` import path stay compatible because the module contents and public entrypoint are preserved.
  - Maintainability: `src/ui` now separates the TUI subsystem from the shared `timeline` renderer, making the directory match the architecture that had already been split at the file level.
  - Verification: reran typecheck, TUI/timeline/CLI coverage, and the unified gate because this slice changes import paths across the renderer, CLI session helpers, and TUI tests.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/tui.test.ts test/unit/timeline.test.ts test/unit/cli.test.ts`: 58 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 34: Retrieval Directory Consolidation

- Scope: improve the `src` file structure by grouping the already-extracted retrieval collaborators under a dedicated `src/retrieval/` directory, without changing the exported `src/retrieval` entrypoint or web-search behavior.
- Implementation:
  - Moved `src/retrieval.ts` into `src/retrieval/index.ts` so existing imports of `../retrieval` continue resolving through the directory entrypoint.
  - Moved retrieval-only collaborators into the same directory: `retrieval-config`, `retrieval-format`, and `retrieval-live`.
  - Rewired relative imports so the retrieval internals reference shared `easycode-path` and `tls-config` through stable parent paths.
- Code Complete review result:
  - Correctness: this is a directory-boundary change only; `WebSearchService`, `McpSourceService`, and the `hasConfiguredWebSearch()` entrypoint remain compatible because the module contents and public import path are preserved.
  - Maintainability: `src` now treats retrieval as a self-contained subsystem instead of a split set of root-level helper files.
  - Verification: reran typecheck plus retrieval, tool, context, session, runner, and CLI coverage because this slice changes import paths used by startup checks and tool-backed web-search flows.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/retrieval.test.ts test/unit/session.test.ts test/unit/context.test.ts test/unit/runner.test.ts test/unit/tool.test.ts test/unit/cli.test.ts`: 129 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 35: Instrumentation Directory Consolidation

- Scope: improve the `src` file structure by grouping the already-extracted instrumentation collaborators under a dedicated `src/instrumentation/` directory, without changing the exported `src/instrumentation` entrypoint or logging behavior.
- Implementation:
  - Moved `src/instrumentation.ts` into `src/instrumentation/index.ts` so existing imports of `../instrumentation` continue resolving through the directory entrypoint.
  - Moved instrumentation-only collaborators into the same directory: `instrumentation-context` and `instrumentation-provider`.
  - Rewired relative imports so instrumentation internals reference shared `agent`, `context`, `logger`, `message`, `provider`, `skill`, and `tool` modules through stable parent paths.
- Code Complete review result:
  - Correctness: this is a directory-boundary change only; `createRunAspect()` and the logging decorators keep the same behavior because the module contents and public import path are preserved.
  - Maintainability: instrumentation is now clearly scoped as a subsystem instead of root-level helpers orbiting a single façade file.
  - Verification: reran typecheck plus retrieval, tool, context, session, runner, and CLI coverage because instrumentation is used across runner, provider, and tool execution paths.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/retrieval.test.ts test/unit/session.test.ts test/unit/context.test.ts test/unit/runner.test.ts test/unit/tool.test.ts test/unit/cli.test.ts`: 129 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 36: Session Directory Consolidation

- Scope: improve the `src` file structure by grouping the already-extracted session collaborators under a dedicated `src/session/` directory, without changing the exported `src/session` entrypoint, session file shape, or restore behavior.
- Implementation:
  - Moved `src/session.ts` into `src/session/index.ts` so existing imports of `../session` continue resolving through the directory entrypoint.
  - Moved `session-tail` into the same directory so persistence and persisted-tail policy live together as one subsystem.
  - Rewired relative imports so the session internals reference shared `context`, `easycode-path`, `message`, and `settings` modules through stable parent paths.
- Code Complete review result:
  - Correctness: this is a directory-boundary change only; `SessionStore`, `SessionTokenUsage`, persisted-tail pruning, and restore behavior remain compatible because the module contents and public import path are preserved.
  - Maintainability: session persistence and session-tail policy now live in one explicit module boundary instead of being split across unrelated root-level files.
  - Verification: reran typecheck plus retrieval, tool, context, session, runner, and CLI coverage because this slice changes imports used by startup, session restore, and TUI session rendering.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/retrieval.test.ts test/unit/session.test.ts test/unit/context.test.ts test/unit/runner.test.ts test/unit/tool.test.ts test/unit/cli.test.ts`: 129 pass, 0 fail.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 37: Roadmap Completion Audit

- Scope: close the readability and architecture roadmap by auditing the current tree against the roadmap’s named phases and success criteria, without changing runtime behavior.
- Implementation:
  - Audited the current module boundaries against the roadmap and confirmed the intended subsystems now exist as explicit directories or focused helper boundaries: `src/agent/runner/`, `src/ui/tui/`, `src/retrieval/`, `src/instrumentation/`, `src/session/`, `src/context/*`, and `src/tool/builtins/*`.
  - Updated `specs/014-readability-refactor-roadmap.md` with a completion status and a current-state evidence section, so the roadmap now records why it is considered complete instead of relying only on scattered progress-log slices.
  - Kept the earlier phase descriptions as historical baseline notes while making the completion decision rest on the current tree and current verification evidence.
- Code Complete review result:
  - Correctness: no runtime code changed; this step only records the current completion state after checking the actual source tree, export surfaces, and verification outputs.
  - Maintainability: the roadmap now has an explicit closeout section, so future work can distinguish between the original hotspot baseline and the post-refactor module layout.
  - Verification: reran typecheck plus the unified gate on the committed runtime tree, and rechecked the main subsystem boundaries directly in source before marking the roadmap complete.
- Verification:
  - `bun run typecheck`: pass.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 38: Instruction Resolver Stable Multi-file Loading

- Scope: strengthen the minimal instruction resolver so project/global durable instruction loading matches the acceptance contract more closely, without changing prompt ordering relative to dynamic conversation history.
- Implementation:
  - Updated `src/instruction.ts` to resolve all existing project and global instruction files in stable order instead of stopping after the first project hit and the first global hit.
  - Preserved the current ordering contract: project instruction files still load before global ones, and both still appear before dynamic history in composed provider context.
  - Expanded unit and integration coverage so the resolver now proves multiple project/global instruction files are surfaced together and still precede the user prompt in provider input.
- Code Complete review result:
  - Correctness: durable instruction loading now matches the plural acceptance language for project/global instruction files while preserving the same prompt boundary and source tagging format.
  - Maintainability: the instruction service now behaves more like a true minimal resolver instead of a first-hit shortcut, which reduces hidden configuration loss when repos carry both `easycode.md` and `AGENTS.md`.
  - Verification: reran instruction-focused unit/integration coverage plus the unified gate because this change affects composed provider context for every run.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/instruction.test.ts test/integration/agent.test.ts`: pass.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 39: Code Index Multiline Comment And String Masking

- Scope: reduce false-positive code-navigation references by teaching the code index to ignore multiline comments and multiline string bodies, without changing definition/call graph contracts.
- Implementation:
  - Added a shared stateful masking helper in `src/tool/code-navigator/parsing.ts` that preserves line shape while stripping `/* ... */`, multiline template strings, and Python triple-quoted strings from semantic scanning.
  - Rewired `src/tool/code-navigator/code-index.ts` to use the masked lines for `calls` and `references` extraction instead of a line-local string/comment stripper.
  - Reused the same masked lines in generic local-binding scope extraction so non-TypeScript languages also stop learning bogus bindings from multiline comment/string bodies.
  - Added regression coverage for TypeScript block comments + multiline template literals and for Python triple-quoted strings.
- Code Complete review result:
  - Correctness: symbol lookup now avoids counting comment/docstring/template-literal noise as semantic references, which makes the code index a clearer improvement over raw text search in same-name collision cases.
  - Maintainability: masking now lives in one shared helper instead of duplicated per-line heuristics, so future parser tweaks do not need to be repeated in both reference extraction and generic scope extraction.
  - Verification: reran code-navigation-focused unit tests plus the unified gate because this changes the shared code-index path used by `repo_map`, `find_definition`, `find_references`, and `call_graph`.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/code-navigator.test.ts`: pass.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 40: Default Import Alias Resolution In Code Index

- Scope: fix a cross-file code-navigation misresolution where default imports could bind to the wrong exported symbol in the target file, without changing `repo_map` or search tool contracts.
- Implementation:
  - Added explicit `exportStyle` metadata to indexed symbols so the code index distinguishes `export default` from ordinary named exports.
  - Updated import resolution so `import foo from "./leaf"` resolves only to the target file's default export instead of falling back to the first exported symbol.
  - Bumped the code-index generator version so cached indexes rebuild with the new symbol metadata.
  - Added a regression test proving `call_graph` follows a default-import alias to the actual default export, not to an unrelated named export in the same file.
- Code Complete review result:
  - Correctness: cross-file default-import navigation now preserves semantic identity for callers/callees, which closes a real gap between AST-backed navigation and naive text matching.
  - Maintainability: export intent is now explicit in the index schema instead of being inferred from a lossy boolean at import-resolution time.
  - Verification: reran code-navigation-focused unit tests plus the unified gate because this changes cached index structure and cross-file symbol resolution.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/code-navigator.test.ts`: pass.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 41: Namespace Import Member Resolution In Code Index

- Scope: fix a code-navigation gap where namespace-import member calls such as `leafApi.leaf()` could lose their semantic target under same-name collisions, without changing tool output shapes.
- Implementation:
  - Added optional `receiverName` metadata on indexed edges so call extraction can preserve the property receiver for member calls.
  - Updated code-index import resolution to use the receiver alias when matching import bindings, which lets `import * as leafApi from "./leaf"` resolve `leafApi.leaf()` to the imported file instead of falling back to ambiguous global name matching.
  - Bumped the code-index generator version so cached indexes rebuild with the new edge metadata.
  - Added a regression test proving `call_graph` resolves namespace-import member calls to the intended imported file even when another file exports the same symbol name.
- Code Complete review result:
  - Correctness: namespace-import call edges now keep their semantic target under same-name collisions, which closes another gap between the code index and plain text search.
  - Maintainability: receiver-aware resolution is localized to code-index edge metadata and import resolution, instead of relying on brittle preview-text heuristics later.
  - Verification: reran code-navigation-focused unit tests plus the unified gate because this changes cached edge structure and cross-file call resolution.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/code-navigator.test.ts`: pass.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.

## Step 42: Re-export Barrel Resolution In Code Index

- Scope: fix a code-navigation gap where named imports through a local re-export barrel could lose their semantic target under same-name collisions, without changing tool output shapes.
- Implementation:
  - Added optional `exportBindings` metadata on indexed files so the code index records local `export { ... }` aliases and `export { ... } from "./impl"` re-export bindings.
  - Updated import resolution to follow named exports through local barrel files before falling back to ambiguous project-wide name matching.
  - Bumped the code-index generator version so cached indexes rebuild with the new export-binding metadata.
  - Added a regression test proving `call_graph` resolves `import { leaf } from "./index"` through `index.ts -> impl.ts` even when another file exports the same symbol name.
- Code Complete review result:
  - Correctness: named re-export barrels now preserve semantic identity for cross-file callers, which closes another common real-world gap between the code index and raw text search.
  - Maintainability: re-export intent is now explicit in cached file metadata instead of being inferred indirectly from export edges and global name uniqueness.
  - Verification: reran code-navigation-focused unit tests plus the unified gate because this changes cached file metadata and import resolution behavior.
- Verification:
  - `bun run typecheck`: pass.
  - `bun test test/unit/code-navigator.test.ts`: pass.
  - `bun run gate`: all local checks pass; remaining failure is `provider_gate` for real `deepseek` connectivity only.
