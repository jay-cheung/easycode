# Acceptance Criteria

## Functional
- `bun run gate` passes and is the required post-change local quality gate.
- `bun test` passes.
- `bun run eval --provider fake` passes all local eval tasks.
- `bun run apix:eval --provider simulated --table` remains available for targeted APIx inspection, while the default gate runs the calibrated simulated hard-gate subset automatically.
- `bun run gate` includes `build` and a real-provider readiness pass in the same reportable run.
- Provider gates skip explicitly when required credentials are missing instead of reporting fabricated real-provider results.
- Real-provider checks inside `bun run gate` target configured real providers by default and can be narrowed with `--provider` / `--providers`.
- `easycode` without a prompt starts the interactive unified run session.
- `easycode "..."` runs a single task and exits; `--once` is no longer required.
- Multi-step, risky, or symbol-affecting unified runs can return `<proposed_plan>` before any edit occurs.
- A returned `<proposed_plan>` does not auto-execute in the same turn; execution continues only after explicit approval.
- Planning-stage responses fail closed unless the final assistant message is a `<proposed_plan>...</proposed_plan>` block or a `plan_exit` tool call that produces one.
- Once an approved plan is executing, step completion advances automatically to the next step in the same run without asking the user whether to continue.
- Unified-mode plans include symbol-aware edit planning details for symbol-affecting code changes: target symbols, owning definitions, affected references/callers, excluded same-name matches, and edit boundaries.
- Structured plan extraction from a markdown plan fails closed: invalid JSON or invalid step shape does not activate an executable plan.
- `easycode "..." --provider fake` can complete read -> edit -> bash.
- `easycode "..." --provider fake` uses symbol-aware edit planning before symbol-affecting edits and can explain when such planning is unnecessary.
- `easycode --provider fake` creates `default` when the project has no saved sessions.
- `easycode --provider fake` prompts for an existing or new session when saved sessions exist.
- `easycode --session demo --provider fake` starts the named interactive session.
- `easycode --provider fake --tui` provides the same interactive capabilities as the plain CLI: session selection, slash commands, queued input, cancellation, permission prompts, plan approval, timeline events, settings changes, image attachment, skills, and saved sessions.
- `easycode "..." --provider fake --tui` renders the TUI shell and the normal run timeline without changing runner behavior.
- First interactive startup without `EASYCODE_LANG` prompts for a UI language choice and saves it for later sessions.
- `/sessions` lists saved sessions and marks the active one in interactive mode.
- `/lang <code>` updates the fixed CLI/TUI language for the current session and persists the default in `~/.easycode/.env`.
- `/session switch <id>` switches the active interactive session and reloads that session's saved settings.
- `/session delete <id>` archives a short summary into project memory, deletes the session file, logs, and saved plans, and keeps the interactive shell on a valid session.
- Project memory records in `.easycode/memory.json` are structured, backward-compatible, and queryable through `memory_query`.
- Continuation-style prompts such as `继续`, `上次`, `resume`, or `continue` can trigger bounded automatic project-memory recall.
- `memory_promote` stores only promotable durable lesson kinds and rejects oversized narrative memory payloads.
- Memory retrieval applies ranking refinements that filter trigger-word noise, boost matching active-file scope, and deduplicate repeated records before bounded recall.
- Non-logger interactive sessions render thinking/tool/answer timeline blocks.
- `--logger` sessions keep structured logs and do not render the timeline.
- `/image` attaches an image to the next prompt only when the active provider supports images.
- `/thinking` and `/effort` update provider reasoning options for the session.
- Project/global instruction files are loaded before dynamic conversation history.
- `/skill use <name>` persists active skill selection and requires one first-use `skill` tool load.
- Skills expose title/description before full content is requested.
- Context compaction preserves summary plus the most recent three user turns by default.
- Context compaction summaries keep the latest user language, respect the active summary token budget, preserve the current diagnostic hypothesis when still supported, and avoid replaying raw tool noise by default.
- Active structured plans persist their current step, step-status map, and lifecycle status during the live session without requiring raw message-history reconstruction.
- Active structured plans replan only on explicit revision/scope-change prompts; ordinary status or progress questions do not rewrite the saved plan.
- MCP stays default-allowed, and WebSearch is default-allowed with structured citations, logger events, eval fixtures, and Tavily-only live search when configured.
- `web_fetch` stays default-allowed for bounded readonly HTTP/HTTPS fetches with structured citation metadata, and supported readonly `curl` bash usage keeps `web_fetch` replacement metadata without being blocked solely for replaceability.
- LSP/AST indexing demonstrates an advantage over text search by resolving definitions/references and constraining edits to symbols rather than same-name text matches.

## Safety
- Workspace writes outside the project root fail.
- Bash scratch I/O may use `/tmp`, `/private/tmp`, `/dev/null`, `/private/dev/null`, and the current session's per-user temp/cache root under `var/folders` without a bypass prompt.
- EasyCode never edits files before a proposed plan is explicitly approved.
- File deletion and git remote bash commands fail hard.
- Replaceable bash inspections run but keep structured audit metadata such as `commandClass` and `replaceableBy`.
- Ordinary bash runs without manual approval; high-risk bash first goes through command-review and asks the user only when the reviewer returns `ask_user` or cannot decide.
- Explicit outside-project paths fail with structured `path_boundary_blocked` feedback instead of requesting `sandbox_bypass`; `/tmp` and `/dev/null` remain allowed scratch exceptions.
- Bash timeout returns structured metadata.
- Large command output is truncated.

## Quality
- No `any` types in source.
- Runtime responsibilities stay in focused modules, and development-only tooling stays outside `src/`.
- No Effect, DI container, MCP, Docker, or plugin system in v1.
- OpenAI provider requires `OPENAI_API_KEY`; fake provider tests require no network.
