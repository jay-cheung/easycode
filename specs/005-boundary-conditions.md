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
- macOS native write-sandbox denials may be retried without the native write sandbox only after an explicit `sandbox_bypass` permission prompt.
- Explicit command paths outside the project may be retried only after an explicit `sandbox_bypass` permission prompt. Dangerous-command checks still apply.
- Timed-out processes return `timedOut=true`.

## Context
- Token count is estimated with a local mixed-language heuristic: CJK characters count as 0.6 tokens and other characters count as 0.3 tokens.
- Compaction triggers above `maxTokens * 0.75`.
- Compaction asks the provider to generate a summary with the compact prompt, then preserves that summary plus the latest 2 complete user turns.

## Provider
- Network/auth/rate-limit/overflow errors become `ProviderError` or tool feedback.
- Fake provider is deterministic and does not use network.
