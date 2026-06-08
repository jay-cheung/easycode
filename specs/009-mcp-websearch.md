# MCP and WebSearch Spec

## Objective

MCP and WebSearch are complementary retrieval surfaces. MCP connects local, enterprise, and plugin-provided tools. WebSearch connects public and time-sensitive external knowledge. Both must feed the same agent-facing evidence model.

## Shared Contract

- Retrieval now uses differentiated defaults because permissions, logging, and eval coverage are already in place.
- MCP reads and `web_search` are default-allowed, while live network paths still obey timeout, TLS, and runtime network boundaries.
- Each retrieval result records source type, source id or URL, title, snippet, retrieved timestamp, and permission decision.
- Agent answers must preserve citations for both MCP resources and web sources.
- Logger output records query text, selected sources, redaction decisions, elapsed time, and failures.
- Tests use fake MCP fixtures and deterministic WebSearch fixtures before any live network path is required.

## MCP Scope

- List configured servers and tools/resources.
- Invoke allowlisted MCP tools through permission checks.
- Read MCP resources through explicit source attribution.
- Surface MCP failures as structured tool results.

## WebSearch Scope

- Search public web data for current or cross-product comparison tasks.
- Fetch result metadata and cite sources.
- Enforce timeout, TLS, and runtime network boundaries without fabricating results.
- Prefer official or primary sources for technical claims.

## Acceptance

- MCP and WebSearch can both contribute cited evidence in one run.
- A failed or unavailable source does not fabricate results.
- Eval fixtures verify citation preservation, timeout handling, and no-source fallback behavior.

## Current Slice

- `mcp_list_resources` reads `.easycode/mcp.json` and returns cited resource summaries.
- `mcp_read_resource` reads one `.easycode/mcp.json` resource by URI and returns citation metadata.
- `web_search` reads `.easycode/websearch.json` fixtures when no live engine is selected.
- `web_search` performs live search only through Tavily when `.easycode/websearch.json` has `defaultEngine: "tavily"` or the tool input specifies `engine: "tavily"`.
- When no `websearch.json` exists, runtime can still default to `tavily` if `TAVILY_API_KEY` is available in the environment.
- Interactive CLI startup prints a setup hint when Tavily is not configured, pointing users to global `~/.easycode/.env` or the current shell environment.
- MCP reads are allowed by default because they are local configured resources.
- `web_search` is default-allowed for both fixture and live modes, and live failures still surface as structured tool/provider errors.
