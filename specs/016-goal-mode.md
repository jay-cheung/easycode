# Goal Mode Technical Design (v1)

## Background

EasyCode already has the core pieces needed for a goal-driven execution layer:

- Structured `ExecutionPlan` data with step-level checkpoints that can already auto-advance within the same session.
- A unified runtime built around `AgentRunner`, `ContextManager`, `PermissionService`, `Sandbox`, and the TUI.
- Internal `delegate_subagent` support for bounded exploration, testing, debugging, review, and documentation research tasks.

The missing layer is a long-lived objective controller. Today, planning is still a bounded execution slice. If the user wants EasyCode to keep working toward a larger objective through repeated planning, execution, and replanning, they still need to drive each round manually.

This document defines an **in-process goal mode v1**: a single long-lived objective managed inside the current interactive EasyCode process, with explicit goal-definition, automatic plan generation, activation, execution, post-slice review, replanning, and stop conditions. v1 explicitly does not add cross-session restore or a background worker system.

## Goals

- Let the user start a long-lived objective through `/goal` instead of only issuing one-shot prompts.
- Require each active goal to record explicit acceptance criteria and completion checks before the first execution plan is created.
- Allow an active goal to generate plans automatically, auto-activate them, execute steps, review each completed slice against the goal contract, and replan as needed until completion, pause, or block.
- Use a default policy of **automatic planning plus layered permissions**, so low-risk work can continue unattended while high-risk actions still stop for the user.
- Reuse existing plan, subagent, compaction, and TUI infrastructure rather than introducing a second execution engine.

## Non-Goals

- No cross-session goal restore in v1.
- No daemon, job queue, scheduler, or multi-goal concurrency in v1.
- No behavior change for ordinary non-goal sessions around plan approval or standard permission prompts.
- No relaxation of existing sandbox, sensitive-file, or dangerous-shell boundaries.

## Core Design

### 1. GoalState

Add an in-process `GoalState` whose lifecycle is tied to the active EasyCode interactive process, not to `SessionStore`.

```ts
type GoalStatus = "idle" | "defining" | "planning" | "executing" | "reviewing" | "paused" | "blocked" | "completed"

type GoalState = {
  id: string
  objective: string
  status: GoalStatus
  iteration: number
  acceptanceCriteria: string[]
  completionChecks: string[]
  activePlanId?: string
  blocker?: string
  startedAt: number
  updatedAt: number
}
```

Constraints:

- At most one active goal per interactive shell.
- Exiting the CLI or switching sessions abandons the goal; it is not restored later.
- Goal state is mirrored into the ledger so compaction, prompt assembly, and TUI surfaces can retain it reliably.

Recommended ledger subjects:

- `current_goal_id`
- `current_goal_objective`
- `current_goal_status`
- `current_goal_iteration`
- `current_goal_acceptance_criteria`
- `current_goal_completion_checks`
- `current_goal_blocker`

### 2. GoalController

Add a `GoalController` at the CLI layer. Its job is to translate a long-lived objective into repeated plan execution rounds.

Layering:

- `goal`: long-lived objective controller
- `plan`: one bounded executable slice
- `step`: one atomic plan progression unit

Controller loop:

1. The user starts `/goal <objective>`.
2. The controller enters `defining` and asks `AgentRunner` to establish the goal contract first.
3. The runner must call `goal_set_acceptance` with explicit acceptance criteria and completion checks before any execution plan is created.
4. The controller enters `planning` and asks `AgentRunner` for the next bounded plan for the active objective.
5. If the runner returns `<proposed_plan>`, goal mode auto-activates the plan instead of waiting for manual approval.
6. The runner executes that plan through the existing `plan_step_complete` / `plan_step_fail` machinery.
7. When the final `plan_step_complete` closes the active plan, the runner must immediately return control to the goal controller instead of continuing inside the same execution run.
8. The controller enters `reviewing` and requires a bounded review/verification pass against the recorded goal contract.
9. Only after review does the controller decide:
   - the goal is satisfied and should call `goal_complete`
   - the goal is not satisfied or review found defects, so the controller starts another planning round
   - the goal cannot continue safely, so it becomes `paused` or `blocked`

### 3. CLI Surface

Add slash commands:

- `/goal <objective>`: start or replace the current goal
- `/goal status`: show current goal state, iteration, active plan, and blocker
- `/goal pause`: pause automatic continuation
- `/goal resume`: resume a paused goal
- `/goal clear`: clear the current goal

Behavior requirements:

- In goal mode, plan generation must no longer trigger the normal `Approve / Reject / Edit` prompt.
- Outside goal mode, the existing plan approval flow remains unchanged.
- If an active goal already exists, `/goal <new objective>` clears the old one first and then creates the new one.

## Agent / Tool / Prompt Changes

### 4. Goal-Level Internal Tools

Add explicit internal tools so goal completion is not inferred from free-form assistant text alone:

- `goal_set_acceptance { acceptanceCriteria: string[]; completionChecks: string[] }`
- `goal_complete { summary: string }`
- `goal_blocked { reason: string }`

Semantics:

- `goal_set_acceptance` may only be used during goal definition and must be called before the first executable plan.
- `goal_complete` may only be called when the objective is satisfied and no plan step is still unresolved.
- `goal_complete` must fail closed if an active plan slice is still running or has not yet passed the required review stage.
- `goal_complete` must fail closed if acceptance criteria and completion checks were never recorded.
- `goal_blocked` is used when progress now depends on user input, a high-risk permission gate, or repeated replanning still cannot produce a safe path forward.

The `GoalController` consumes these tool results and updates `GoalState`. They should not be treated as user-facing final answers on their own.

### 5. Prompt Contract

Do not introduce a third public agent mode. Goal mode should continue to reuse the current `build` / `plan` runtime split, but inject a goal-specific system block whenever a goal is active.

That goal block should contain:

- the current objective
- the current goal iteration
- the current acceptance criteria and completion checks
- the active plan / step summary
- the current blocker, if any
- the allowed exits for the current phase:
  - `defining`: call `goal_set_acceptance` or `goal_blocked`
  - `planning`: produce the next bounded plan, call `goal_complete`, or call `goal_blocked`
  - `reviewing`: review the latest slice, then call `goal_complete`, produce the next bounded plan, or call `goal_blocked`

Model constraints:

- Plans inside goal mode should stay small, verifiable, and continuation-friendly rather than becoming one giant end-to-end plan.
- During active plan execution, the model must still stay focused on the current plan step.
- Pure exploration, testing, debugging, and docs lookup should prefer `delegate_subagent` over coordinator-led manual multi-turn searching.

### 6. Plan / Subagent Coordination

Goal mode should not invent a separate subagent protocol. It should directly reuse existing `delegate_subagent`.

Suggested role boundaries:

- `explorer`: pure code/config/log fact-finding
- `reviewer`: bounded correctness or regression review for one implementation slice
- `debugger`: isolate failure causes, with tightly bounded verification bash
- `tester`: run tests and quality checks, with tightly bounded verification bash
- `docs_researcher`: off-repo or MCP-backed documentation evidence

Plans in goal mode may continue to carry hidden execution metadata such as:

- `executorHint: "main" | "subagent"`
- `subagentRole`

User-visible plan rendering must continue to strip those internal fields.

## Permission And Safety Policy

### 7. Automatic Planning Without Automatic Escalation

Goal mode should default to:

- **automatic plan approval**
- **layered tool permissions**

In practice:

- low-risk read/search/retrieval work auto-runs
- repo-local bounded edits auto-run
- bounded verification bash auto-runs
- high-risk shell, sensitive files, and sandbox bypass still stop for the user

### 8. Goal Permission Profile

Add a dedicated `goal` permission profile, separate from ordinary `build` and `plan`.

Auto-allow by default:

- `read`, `list`, `grep`
- `mcp`
- `web_search`, `web_fetch`
- repo-local `write`, `edit`
- `plan_exit`
- `plan_step_complete`, `plan_step_fail`
- `goal_set_acceptance`, `goal_complete`, `goal_blocked`
- `delegate_subagent`

Auto-allow but still sandbox-bound:

- bounded verification commands such as `bun test`, `bun run typecheck`, `bun run gate`, `npm test`, and similar explicit quality commands

Still ask or deny:

- `git push`
- `sudo`
- `rm -rf`
- `docker`
- `sandbox_bypass`
- reads from `.env` or `secrets/*`
- shell commands that do not match the bounded verification allowlist

Additional requirements:

- `debugger` and `tester` subagents must continue using a stricter shell allowlist than the coordinator.
- Goal mode must not weaken existing sensitive-file or privilege boundaries just because the run is automated.

## State Machines

### 9. Goal State Machine

```text
idle -> defining -> planning -> executing -> reviewing -> planning
         |            |            |            |            |
         -> blocked   -> blocked   -> paused    -> blocked   -> completed
                                    -> blocked   -> paused
```

State meanings:

- `idle`: no active goal
- `defining`: capture goal acceptance criteria and completion checks before planning
- `planning`: generating the next bounded plan for the objective
- `executing`: an active plan is running through its step loop
- `reviewing`: the latest completed plan slice is being verified against the recorded goal contract
- `paused`: user-paused or waiting on a high-risk gate
- `blocked`: there is no safe continuation path without new input or a scope change
- `completed`: the objective is done

### 10. Stop Conditions

Enter `paused` when:

- a high-risk permission gate needs user input
- the user explicitly runs `/goal pause`

Resume semantics:

- resuming a paused goal into a new active plan slice advances the goal iteration, because the resumed work is a new bounded execution attempt rather than a continuation of the previously interrupted slice

Enter `blocked` when:

- goal definition ends without durable acceptance criteria
- repeated replanning still cannot produce a safe plan
- critical verification keeps failing and no narrower follow-up remains
- the active objective conflicts with a new user instruction

Enter `completed` when:

- the model explicitly calls `goal_complete`
- the controller verifies that acceptance criteria were recorded
- the latest review/verification pass found no remaining blocker or defect that prevents completion

## TUI / Logging / Observability

### 11. TUI

Extend the status panel with:

- `Goal: active/paused/blocked/completed`
- an objective summary
- the current iteration
- the active plan id / current step
- the current blocker, when present

Add goal lifecycle timeline events:

- `goal_started`
- `goal_definition`
- `goal_planning`
- `goal_plan_activated`
- `goal_reviewing`
- `goal_paused`
- `goal_blocked`
- `goal_completed`

### 12. Logging

The logger should record:

- goal creation, clearing, pause, and resume
- each planning round and resulting plan activation
- the relationship between goal id and active plan id
- blocker reasons and high-risk permission interruptions

v1 does not need a separate goal transcript file. The existing main session transcript remains the primary narrative surface.

## Test Plan

### 13. Unit Tests

- `/goal` parsing and CLI handlers
- `GoalState` transitions
- goal permission profile evaluation
- `goal_set_acceptance` / `goal_complete` / `goal_blocked` tool semantics
- goal ledger recording and cleanup

### 14. Integration Tests

- `/goal` starts and auto-generates a plan without opening the approval prompt
- `/goal` first records acceptance criteria and completion checks before the first plan
- completed plans automatically trigger the review stage before either replanning or completion
- `goal_complete` closes the goal cleanly
- high-risk shell requests pause the goal
- repeated failures move the goal to `blocked`
- pure exploration, debugging, testing, and docs work prefer `delegate_subagent`
- exiting the shell or switching sessions does not restore the goal afterward

### 15. Acceptance Criteria

- Goal mode records explicit acceptance criteria and completion checks before the first executable slice.
- Goal mode does not require per-round manual plan approval.
- Low-risk actions continue automatically while high-risk actions are still gated.
- One goal can span multiple `define -> plan -> execute -> review -> replan` rounds.
- Ordinary non-goal sessions keep their current approval and permission behavior.
- `bun run gate` passes after implementation.

## Suggested Rollout Phases

### Phase 1

- Add `GoalState`, `/goal` commands, goal ledger state, goal acceptance capture, and goal internal tools.
- Remove manual plan approval only inside goal mode.
- Support a single `goal -> define -> plan -> execute -> review -> complete/blocked` cycle first.

### Phase 2

- Add repeated automatic replanning.
- Add full goal TUI and logger events.
- Tighten goal/subagent coordination policies.

### Phase 3

If v1 proves stable, evaluate:

- cross-session goal persistence
- a background worker or daemon
- multi-goal scheduling

## Decision Summary

The correct v1 boundary is:

- **single in-process goal**
- **automatic planning plus layered permissions**
- **reuse of the existing plan / step / subagent runtime**
- **no cross-session restore and no background execution system**

That keeps the implementation narrow, aligns with EasyCode's current architecture, and fits the product direction of a lightweight, local, inspectable coding agent.
