# easycode Product Spec

easycode is a lightweight specs-driven coding agent. It keeps the agent loop small enough to inspect and test while adding UI, MCP, web search, semantic indexing, subagents, Docker, or remote sync in measured steps.

## Goals
- Provide a compact Bun/TypeScript project with clear module boundaries.
- Support build and plan execution styles.
- Make tools, permissions, context, messages, providers, skills, and sandbox behavior explicit.
- Provide a usable terminal UI that covers the same interactive CLI features instead of creating a separate product path.
- Ship deterministic fake-provider tests and local eval tasks.
- Keep real-provider readiness measurable with repeatable smoke/APIx/cache gates and timestamped reports.

## Non-goals
- No desktop UI in the current scope.
- No plugin marketplace in the current scope.
- No Docker sandbox in v1.
- No persistent database.
- No multi-agent delegation.

## Current Optimization Order
1. Prove real-provider stability with recorded gates before expanding surface area.
2. Ship a usable TUI mode that covers session selection, slash commands, prompts, cancellation, permissions, plan approval, timeline output, and logger compatibility.
3. Add MCP and WebSearch as dual integration surfaces with shared permission, citation, logging, and evaluation contracts.
4. Strengthen semantic navigation with richer LSP/AST indexing for definition/reference lookup, safer symbol-aware edits, and better plan/diff risk assessment.
5. Only add subagents or cloud execution after the single-agent local workflow is dependable.
