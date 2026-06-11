# Boundary Conditions

## Agent Mode
- `plan` mode forbids `write` and `edit`.
- `plan` mode allows bash only for read-only commands such as `pwd`, `ls`, `rg`, `grep`, `find`, `git status`, and `git diff`.
- `build` mode may modify files only after permission and sandbox checks.

## Filesystem
- Writes must stay inside the project root.
- Relative paths resolve against the project root.
- `.env*` defaults to ask.
- `secrets/**` defaults to deny.

## Bash
- Default timeout is 120 seconds.
- Default output cap is 64KB.
- Dangerous commands are denied: `rm -rf`, `sudo`, `git push`, `docker`, `curl | sh`, recursive chmod on `/`.
- Safe readonly bash scopes may auto-approve in `build` mode: `git status|diff|log`, `pwd`, `ls`, `find`, `wc`, common readonly `curl` GET/HEAD fetches with safe flags only, and project-local `cat` / `rg` / `grep` / `sed -n` reads when the target file is small enough and not under `.env*` or `secrets/**`.
- macOS native write-sandbox denials may be retried without the native write sandbox only after an explicit `sandbox_bypass` permission prompt.
- Explicit command paths outside the project may be retried only after an explicit `sandbox_bypass` permission prompt. Dangerous-command checks still apply.
- Repeated `bash` and `sandbox_bypass` approvals are cached by reviewed scope for the current in-memory session only. Simple read-only commands may use a narrow path scope; complex or side-effectful commands use exact-command scope.
- Timed-out processes return `timedOut=true`.

## Retrieval
- `mcp` stays default-allowed.
- `web_search` is default-allowed and continues to return structured citations, fixture/live metadata, and Tavily-only live results when configured.

## Context
- Token count is estimated with a local mixed-language heuristic: CJK characters count as 0.6 tokens and other characters count as 0.3 tokens.
- Compaction triggers above `maxTokens * 0.75`.
- Compaction asks the provider to generate a summary with the compact prompt, then preserves that summary plus the latest 3 complete user turns by default.
- The compaction contract must retain the current user requirement, a traceable direct user-input snippet, and the active capability surface (for example selected skills, MCP usage, connectors, or web-search engine) when they matter for continuation.

## Provider
- Network/auth/rate-limit/overflow errors become `ProviderError` or tool feedback.
- Fake provider is deterministic and does not use network.
