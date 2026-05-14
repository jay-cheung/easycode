# Acceptance Criteria

## Functional
- `bun test` passes.
- `bun run eval --provider fake` passes all local eval tasks.
- `easycode plan --once "..."` does not modify files and returns `<proposed_plan>`.
- `easycode build --once "..." --provider fake` can complete read -> edit -> bash.
- `easycode build --provider fake` starts the default interactive session.
- `easycode build --session demo --provider fake` starts the named interactive session.
- Non-logger interactive sessions render thinking/tool/answer timeline blocks.
- `--logger` sessions keep structured logs and do not render the timeline.
- `/image` attaches an image to the next prompt only when the active provider supports images.
- `/thinking` and `/effort` update provider reasoning options for the session.
- `/skill use <name>` persists active skill instructions for future turns.
- Skills expose title/description before full content is requested.
- Context compaction preserves summary plus the most recent two user turns.

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
