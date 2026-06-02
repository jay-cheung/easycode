# Progress Log

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
