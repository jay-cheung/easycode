# Acceptance Criteria

## Functional
- `bun run gate` passes and is the required post-change local quality gate.
- `bun run verify:v1` passes.
- `bun run verify:full` passes.
- `bun test` passes.
- `bun run eval --provider fake` passes all local eval tasks.
- `bun run apix:eval --provider simulated --table` remains available for targeted APIx inspection, while the default gate runs the calibrated simulated hard-gate subset automatically.
- `bun run provider:gate -- --provider <real-provider>` writes a JSON and Markdown report under `.easycode/reports/provider-gate`.
- `bun run verify:provider -- --provider <real-provider>` writes a JSON and Markdown report under `.easycode/reports/quality-gate`.
- Provider gates skip explicitly when required credentials are missing instead of reporting fabricated real-provider results.
- Release verification runs `bun run verify:provider` automatically for any real providers whose required credentials are configured, and skips with an explicit message when no real-provider credentials are available.
- `easycode plan --once "..."` does not modify files and returns `<proposed_plan>`.
- `easycode plan --once "..."` includes symbol-aware edit planning details for symbol-affecting code changes: target symbols, owning definitions, affected references/callers, excluded same-name matches, and edit boundaries.
- `easycode build --once "..." --provider fake` can complete read -> edit -> bash.
- `easycode build --once "..." --provider fake` uses symbol-aware edit planning before symbol-affecting edits and can explain when such planning is unnecessary.
- `easycode build --provider fake` creates `default` when the project has no saved sessions.
- `easycode build --provider fake` prompts for an existing or new session when saved sessions exist.
- `easycode build --session demo --provider fake` starts the named interactive session.
- `easycode build --provider fake --tui` provides the same interactive capabilities as the plain CLI: session selection, slash commands, queued input, cancellation, permission prompts, plan approval, timeline events, settings changes, image attachment, skills, and saved sessions.
- `easycode build --once "..." --provider fake --tui` renders the TUI shell and the normal run timeline without changing runner behavior.
- `/sessions` lists saved sessions and marks the active one in interactive mode.
- Non-logger interactive sessions render thinking/tool/answer timeline blocks.
- `--logger` sessions keep structured logs and do not render the timeline.
- `/image` attaches an image to the next prompt only when the active provider supports images.
- `/thinking` and `/effort` update provider reasoning options for the session.
- Project/global instruction files are loaded before dynamic conversation history.
- `/skill use <name>` persists active skill selection and requires one first-use `skill` tool load.
- Skills expose title/description before full content is requested.
- Context compaction preserves summary plus the most recent two user turns.
- Context compaction summaries keep the latest user language, respect the active summary token budget, preserve the current diagnostic hypothesis when still supported, and avoid replaying raw tool noise by default.
- MCP and WebSearch both use explicit permission boundaries, structured citations, logger events, and eval fixtures before they become default retrieval sources.
- LSP/AST indexing demonstrates an advantage over text search by resolving definitions/references and constraining edits to symbols rather than same-name text matches.

## Safety
- Writes outside the project root fail.
- Plan-mode edit/write attempts fail.
- Dangerous bash commands fail.
- Native write-sandbox bypass and explicit outside-path bypass require a risk prompt and user approval.
- Repeated approved bash commands reuse the current session approval and do not prompt again.
- Bash timeout returns structured metadata.
- Large command output is truncated.

## Quality
- No `any` types in source.
- Core modules remain one file each.
- No Effect, DI container, MCP, Docker, or plugin system in v1.
- Real Codex provider requires `OPENAI_API_KEY`; fake provider tests require no network.
