# Boundary Conditions

## Agent Mode
- `plan` mode forbids `write` and `edit`.
- `plan` mode allows bash only for read-only commands such as `pwd`, `ls`, `rg`, `grep`, `find`, `git status`, and `git diff`.
- `build` mode may modify files only after permission and sandbox checks.

## Filesystem
- Workspace file writes must stay inside the project root.
- Relative paths resolve against the project root.
- `.env*` defaults to ask.
- `secrets/**` defaults to deny.
- The macOS native write sandbox may also allow the current session's per-user temp/cache root under `var/folders` so implicit TLS/toolchain scratch writes do not force a bypass prompt for ordinary networked commands.

## Bash
- Default timeout is 120 seconds.
- Default output cap is 64KB.
- Dangerous commands are denied: `rm -rf`, `sudo`, `git push`, `docker`, `curl | sh`, recursive chmod on `/`.
- Replaceable bash inspections that already map to internal tools are blocked instead of auto-approved: simple `git status|diff|log`, project-local `cat`, `rg` / `grep`, `sed -n` line reads, and supported readonly `curl` fetches that can be safely represented through `web_fetch`.
- Safe readonly bash fallback scopes may auto-approve in `build` mode only when there is no equivalent internal tool path: `pwd`, `ls`, `find`, and `wc`.
- macOS native write-sandbox denials may be retried without the native write sandbox only after an explicit `sandbox_bypass` permission prompt.
- Explicit command paths outside the project may be retried only after an explicit `sandbox_bypass` permission prompt. Dangerous-command checks still apply.
- Repeated `bash` and `sandbox_bypass` approvals are cached by reviewed scope for the current in-memory session only. Simple read-only commands may use a narrow path scope; complex or side-effectful commands use exact-command scope.
- Timed-out processes return `timedOut=true`.

## Retrieval
- `mcp` stays default-allowed.
- `web_search` is default-allowed and continues to return structured citations, fixture/live metadata, and Tavily-only live results when configured.
- `web_fetch` is default-allowed for bounded GET/HEAD requests over `http`/`https`, with safe headers only, no implicit redirect following unless requested, and a truncated response body excerpt.

## Context
- Token count is estimated with a local mixed-language heuristic: CJK characters count as 0.6 tokens and other characters count as 0.3 tokens.
- Compaction triggers above `maxTokens * 0.75`.
- Compaction asks the provider to generate a summary with the compact prompt, then preserves that summary plus the latest 3 complete user turns by default.
- The compaction contract must retain the current user requirement, a traceable direct user-input snippet, and the active capability surface (for example selected skills, MCP usage, connectors, or web-search engine) when they matter for continuation.

## Provider
- Network/auth/rate-limit/overflow errors become `ProviderError` or tool feedback.
- Fake provider is deterministic and does not use network.
