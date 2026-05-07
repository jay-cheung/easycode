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
- Timed-out processes return `timedOut=true`.

## Context
- Token count is estimated with `ceil(chars / 4)`.
- Compaction triggers above `maxTokens * 0.75`.
- Compaction preserves summary plus the latest 4 messages.

## Provider
- Network/auth/rate-limit/overflow errors become `ProviderError` or tool feedback.
- Fake provider is deterministic and does not use network.
