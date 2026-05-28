# easycode Product Spec

easycode is a lightweight specs-driven coding agent. It keeps the agent loop small enough to inspect and test before adding UI, MCP, subagents, Docker, or remote sync.

## Goals
- Provide a compact Bun/TypeScript project with clear module boundaries.
- Support build and plan execution styles.
- Make tools, permissions, context, messages, providers, skills, and sandbox behavior explicit.
- Ship deterministic fake-provider tests and local eval tasks.
- Keep real-provider readiness measurable with repeatable smoke/APIx/cache gates and timestamped reports.

## Non-goals
- No TUI or desktop UI.
- No MCP or plugin marketplace.
- No Docker sandbox in v1.
- No persistent database.
- No multi-agent delegation.

## Current Optimization Order
1. Prove real-provider stability with recorded gates before expanding surface area.
2. Improve interactive review and session ergonomics.
3. Add one integration surface at a time, starting with MCP or web search.
4. Strengthen semantic navigation with richer language-aware indexing.
5. Only add subagents or cloud execution after the single-agent local workflow is dependable.
