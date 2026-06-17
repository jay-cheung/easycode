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
- The macOS native write sandbox also allows `/tmp`, `/private/tmp`, `/dev/null`, `/private/dev/null`, and the current session's per-user temp/cache root under `var/folders` for ordinary scratch I/O.
- Tool-level path boundary checks still run even when the native write sandbox is unavailable.
- Explicit `~/...`, absolute paths, Windows-style absolute paths, and `..` traversal references are resolved before boundary decisions.

## Sandbox Platform Matrix
| Platform | Native write sandbox | Path boundary check | Result metadata |
| --- | --- | --- | --- |
| macOS with `/usr/bin/sandbox-exec` | enabled for shell execution | always enabled | `nativeWriteSandbox=true`, `sandboxBypassed=false` |
| macOS without `sandbox-exec` | unavailable | always enabled | `sandboxBypassed=true` |
| Linux | unavailable until a Linux backend is added | always enabled | `sandboxBypassed=true` |
| Windows | unavailable until a Windows backend is added | always enabled | `sandboxBypassed=true` |

When `sandboxBypassed=true`, EasyCode must treat native write containment as unavailable and rely on path-boundary checks, permission rules, hard-denied command rules, and command-review.

## Bash
- Default timeout is 120 seconds.
- Default output cap is 64KB.
- Hard-denied commands are file deletion and git remote operations: `rm`, `rmdir`, `unlink`, `trash`, `find ... -delete`, `git clean`, `git push`, `git pull`, `git fetch`, `git clone`, `git remote`, `git ls-remote`, and remote submodule updates.
- Ordinary bash is allowed by default in build mode, including pipes, inline `node` / `python`, verification commands, readonly commands, and project-local skill scripts.
- High-risk commands use command-review before any user prompt: `sudo`, `docker` / similar container entrypoints, `curl|sh` remote script execution, package install/update commands, `chmod` / `chown` / `chgrp`, background process launch, sensitive path access, and network upload/sync forms.
- Replaceable bash inspections still attach `commandClass` / `replaceableBy` audit metadata, but they are no longer blocked solely because an internal tool exists.
- `sandbox_bypass` is not part of the default flow. Native write-sandbox denials and explicit outside-project path references return structured tool failures to the model.
- Explicit command paths outside the project are blocked unless they resolve under `/tmp`, `/private/tmp`, the current system temp root, `/dev/null`, or `/private/dev/null`.
- Timed-out processes return `timedOut=true`.

## Retrieval
- `mcp` stays default-allowed.
- `web_search` is default-allowed and continues to return structured citations, fixture/live metadata, and Tavily-only live results when configured.
- `web_fetch` is default-allowed for bounded GET/HEAD requests over `http`/`https`, with safe headers only, no implicit redirect following unless requested, and a truncated response body excerpt.

## Context
- Token count is estimated with a local mixed-language heuristic: CJK characters count as 0.6 tokens and other characters count as 0.3 tokens.
- Compaction triggers above `maxTokens * 0.75`.
- Compaction asks the provider to generate a summary with the compact prompt. If the provider summary fails, EasyCode writes a local fallback summary containing the failure and a bounded transcript excerpt, then still applies the compaction snapshot.
- Compaction preserves the summary plus the latest 3 complete user turns by default.
- The compaction contract must retain the current user requirement, a traceable direct user-input snippet, and the active capability surface (for example selected skills, MCP usage, connectors, or web-search engine) when they matter for continuation.

## Provider
- Network/auth/rate-limit/overflow errors become `ProviderError` or tool feedback.
- Fake provider is deterministic and does not use network.
- Provider readiness diagnostics are local first: unknown provider names or missing required environment variables can fail/skip before smoke evals. Real network reachability is still validated by provider gate smoke checks.

## Plan and Subagent Timeouts
- `PlanStep.timeoutMs` is optional and capped at 30 minutes.
- `delegate_subagent.timeoutMs` is optional and capped at 30 minutes.
- An explicit subagent timeout overrides the active assigned plan-step timeout.
- Timed-out subagents return failed tool metadata with `error="subagent_timeout"` and a retryable handoff summary.
