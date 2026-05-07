# easycode Product Spec

easycode is a lightweight specs-driven coding agent. It keeps the agent loop small enough to inspect and test before adding UI, MCP, subagents, Docker, or remote sync.

## Goals
- Provide a compact Bun/TypeScript project with clear module boundaries.
- Support build and plan execution styles.
- Make tools, permissions, context, messages, providers, skills, and sandbox behavior explicit.
- Ship deterministic fake-provider tests and local eval tasks.

## Non-goals
- No TUI or desktop UI.
- No MCP or plugin marketplace.
- No Docker sandbox in v1.
- No persistent database.
- No multi-agent delegation.
