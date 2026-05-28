# Progress Log

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
