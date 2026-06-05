# Readability And Architecture Refactor Roadmap

Status: Completed on 2026-06-05 after the completion audit below.

## Objective

Improve readability and architectural coherence without changing EasyCode's observable behavior.

This roadmap is for structural refactors only. Each slice must preserve:

- CLI flags, prompts, and session workflow
- tool names, input schemas, permissions, and result shapes
- provider streaming semantics and `RunUiEvent` contracts
- session file schema and restore behavior
- quality-gate outcomes and eval coverage

## Non-goals

- No product-surface expansion
- No new provider or tool behavior
- No schema or persistence format migration
- No broad rename-only churn across unrelated modules
- No mixed structural-refactor + feature-fix mega commits

## Current State

The runtime core is still understandable, but several high-traffic modules have accumulated too many responsibilities:

- `src/agent/runner.ts`: run-loop orchestration, provider streaming, tool execution, summary background work, failure policy, and UI events
- `src/ui/tui.ts`: TUI state machine, ANSI layout helpers, card rendering, and status-panel drawing
- `src/tool/builtins.ts`: registry assembly, schemas, tool-family registration, and tool-specific formatting
- `src/instrumentation.ts`: logging decorators, provider transcript rendering, token heuristics, and context snapshots
- `src/retrieval.ts`: MCP formatting, citation building, engine normalization, request creation, ranking, parsing, and timeout handling
- `src/context/manager.ts` + `src/session.ts`: compaction strategy, preserved-tail logic, and session persistence policy are related but not explicitly separated

Large files are not the problem by themselves. The refactor priority comes from responsibility overlap, side-effect density, and how hard it is to verify behavior after a change.

## Behavior Preservation Rules

Every refactor phase must satisfy all of the following:

1. The public contract stays stable.
   - `createRunner(...)`, CLI entrypoints, tool registry contents, `RunUiEvent`, and persisted session schema must stay compatible.
2. The refactor is structurally scoped.
   - First move code into clearer boundaries.
   - Only then consider local naming cleanup inside the same boundary.
   - Do not combine a structural move with a semantic fix unless a failing test proves it is necessary.
3. Verification is part of the change, not a follow-up.
   - Each slice must update `specs/011-progress-log.md`.
   - Each slice must run `bun run gate`.
4. Refactor commits stay single-theme.
   - UI refactor, tool-registry refactor, and session-persistence changes should not ship in the same commit.

## Refactor Strategy

Use this sequence:

1. Freeze behavior with characterization coverage.
2. Refactor outer presentation and registry layers first.
3. Refactor the run loop only after supporting tests and boundaries are in place.
4. Clean up context/session policy after the runner and UI surfaces are easier to reason about.

The sequencing is deliberate: lower-risk modules reduce cognitive load and make later high-risk refactors safer.

## Phase 0: Behavior Guardrails

### Goal

Establish a reliable baseline for "no behavior change".

### Work

- Add or tighten characterization coverage for:
  - TUI prompt/status/timeline behavior
  - runner event flow and cancellation behavior
  - tool registry shape and representative tool outputs
  - session save/restore tails and compaction interaction
- Record the expected verification set for each refactor slice.

### Deliverables

- Repo-grounded refactor guardrails in this spec
- Missing characterization tests added where current coverage is too indirect

### Verification

- targeted unit/integration tests for the touched area
- `bun run gate`

## Phase 1: UI Layer Separation

### Goal

Turn `src/ui/tui.ts` into a thin façade instead of a mixed state/render/layout file.

### Target Boundaries

- `src/ui/tui.ts`
  - public renderer façade and event entrypoint
- `src/ui/tui-state.ts`
  - running/streaming/paused/status transitions
- `src/ui/ansi.ts`
  - visible-width and truncation helpers
- `src/ui/cards.ts`
  - welcome, session, success, failure, and info card builders
- `src/ui/status-panel.ts`
  - live monitor line generation and redraw policy

### Why First

- High readability gain
- Low semantic risk
- Strong existing CLI/TUI coverage

### Constraints

- Do not change `RunUiEvent`
- Do not fork TUI and non-TUI execution
- Keep line-oriented output behavior compatible with current tests

### Verification

- `bun test test/unit/cli.test.ts`
- TUI-specific tests if present or added
- `bun run gate`

## Phase 2: Tool Registry Decomposition

### Goal

Split `src/tool/builtins.ts` by tool family so the registry is declarative instead of a single long constructor.

### Target Boundaries

- `src/tool/builtins.ts`
  - top-level registry assembly only
- `src/tool/families/fs.ts`
- `src/tool/families/git.ts`
- `src/tool/families/retrieval.ts`
- `src/tool/families/memory.ts`
- `src/tool/families/planning.ts`
- optional shared helpers:
  - `src/tool/schemas.ts`
  - `src/tool/formatters.ts`

### Design Rule

Each family module should export registered tool definitions or registration helpers. It should not create its own registry instance.

### Risks

- Silent drift in tool descriptions or schemas
- Permission or mode mismatches during extraction

### Verification

- `bun test test/unit/tool.test.ts`
- permission/retrieval/code-navigation tests relevant to touched tools
- `bun run gate`

## Phase 3: Runner Layering

### Goal

Refactor `src/agent/runner.ts` from a monolithic class into explicit collaborators while preserving the current orchestration contract.

### Target Boundaries

- `src/agent/runner.ts`
  - lifecycle orchestration only
- `src/agent/provider-turn.ts`
  - provider-stream normalization, deltas, replay events, and provider failures
- `src/agent/tool-execution.ts`
  - tool loop, result recording, cancellation handling, and plan-exit handling
- `src/agent/summary-subagent.ts`
  - background summary lifecycle and summary-readiness policy
- `src/agent/runner-events.ts`
  - `RunUiEvent` emission and provider-metrics bridging
- `src/agent/failure-policy.ts`
  - failure text, recovery hints, truncation rules, and terminal result assembly

### Preconditions

- Runner characterization coverage must exist first
- UI and tool-registry layers should already be simpler, so event flow is easier to inspect

### Risks

- cancellation regressions
- plan/build transition regressions
- background summary lifecycle bugs
- event ordering changes that only show up in integration tests

### Verification

- `bun test test/integration/agent.test.ts test/unit/context.test.ts`
- any runner-targeted unit tests added in Phase 0
- `bun run gate`

## Phase 4: Context And Session Policy Clarification

### Goal

Separate "context compaction policy" from "persisted session tail policy" and make their interaction explicit.

### Target Boundaries

- `src/context/manager.ts`
  - strategy orchestration only
- `src/context/strategy.ts`
  - token budget and window policy
- `src/context/compaction.ts`
  - summary insertion and preserved-tail policy for live context
- `src/session.ts`
  - filesystem persistence only
- `src/session-tail.ts` or `src/context/session-tail.ts`
  - persisted message-tail selection rules

### Why This Phase Comes Later

This area is behavior-sensitive and is currently entangled with active session-workflow changes in the worktree. It should be isolated after the larger orchestration surfaces are cleaner.

### Risks

- replaying already-answered user turns
- dropping a necessary assistant tail
- summary/preserved-tail interactions diverging between save and restore paths

### Verification

- `bun test test/unit/session.test.ts test/unit/context.test.ts test/unit/cli.test.ts`
- `bun run gate`

## Phase 5: Cross-cutting Service Cleanup

### Goal

Decompose medium-large service modules that currently mix formatting, policy, and IO preparation.

### Candidates

- `src/instrumentation.ts`
  - split logging decorators, provider transcript formatting, token estimation, and context snapshots
- `src/retrieval.ts`
  - split citations, engine normalization, request builders, parsers, ranking, and timeout helpers
- provider helpers
  - extract shared OpenAI-like behavior where duplication is currently structural, not incidental

### Constraints

- No provider API drift
- No retrieval contract drift
- No change to logger file layout unless explicitly scoped and re-verified

### Verification

- provider/retrieval/instrumentation targeted tests
- `bun run gate`

## Recommended Execution Order

### Week 1

- Phase 0
- Phase 1
- Phase 2

### Week 2

- Phase 3

### Week 3

- Phase 4
- Phase 5

If the team needs a more conservative pace, Phase 3 should stand alone in its own window.

## Working Rules For Each Slice

- Start from a clean diff for the specific target area whenever possible.
- Do not overlap structural refactors with the active `session` behavior changes currently in the worktree.
- Prefer pure-function extraction before collaborator extraction.
- Keep imports directional:
  - UI depends on timeline/types, not agent internals
  - runner depends on services, not UI render helpers
  - session persistence depends on context/message policy helpers, not the reverse
- Keep each final file understandable at a glance:
  - façade/orchestrator files should mostly read as control flow
  - helper modules should mostly read as local policy or formatting logic

## Success Criteria

The roadmap is complete when:

- the large hotspot modules have clearer single-purpose boundaries
- the runtime-facing contracts remain stable
- every completed slice has a matching progress-log entry
- each slice has passed `bun run gate`
- new contributors can locate UI, runner, tool, retrieval, and session responsibilities without reading multiple unrelated subsystems first

## Completion Audit (2026-06-05)

### Result

The roadmap objective is complete.

### Evidence

- Hotspot boundaries are now explicit:
  - runner orchestration lives at `src/agent/runner/index.ts`, with runner-only collaborators grouped under `src/agent/runner/`
  - TUI orchestration lives at `src/ui/tui/index.ts`, with state/render/layout helpers grouped under `src/ui/tui/`
  - retrieval lives under `src/retrieval/` with separate config, formatting, and live-request helpers
  - instrumentation lives under `src/instrumentation/` with separate provider and context logging helpers
  - session persistence lives under `src/session/`, while context budgeting/compaction helpers live under `src/context/`
  - tool registry assembly is a thin `src/tool/builtins.ts` façade over focused family modules in `src/tool/builtins/`
- Runtime-facing contracts remain stable:
  - `src/agent/index.ts` still re-exports the runner entrypoint through `./runner`
  - imports such as `../ui/tui`, `../retrieval`, `../instrumentation`, and `../session` still resolve through directory entrypoints
  - the latest local verification kept typecheck, tests, eval, APIx subset, cache benchmark, and build green
- Every structural slice has a matching progress-log entry:
  - tool registry split: Step 11
  - context decomposition: Steps 22, 23, 24, 28
  - runner layering: Steps 25, 26, 29, 30, 32
  - session policy and subsystem boundary: Steps 27, 36
  - TUI decomposition and subsystem boundary: Steps 22, 31, 33
  - retrieval and instrumentation cleanup: Steps 20, 21, 34, 35
- Verification evidence is current:
  - `bun run typecheck`: pass on 2026-06-05
  - focused runner/context/session/retrieval/TUI tests: pass on 2026-06-05
  - `bun run gate`: all local checks pass on 2026-06-05; the only remaining failure is the known external `provider_gate` connectivity path for real `deepseek`

### Notes

- The file paths listed in the earlier phase descriptions describe the original hotspot locations at the time this roadmap was created.
- The completion state is based on current source boundaries and current verification evidence, not just the historical plan.
