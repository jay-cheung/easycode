import { ledgerRecord } from "./agent/ledger"
import type { ContextLedger, ContextManagerLike, StructuredContextLedger } from "./context"

export type GoalStatus = "defining" | "planning" | "executing" | "reviewing" | "paused" | "blocked" | "completed"

export type GoalState = {
  id: string
  objective: string
  status: GoalStatus
  iteration: number
  acceptanceCriteria: string[]
  completionChecks: string[]
  blocker?: string
  startedAt: number
  updatedAt: number
  activePlanId?: string
  summary?: string
}

export class GoalStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GoalStateError"
  }
}

const goalStatuses = new Set<GoalStatus>(["defining", "planning", "executing", "reviewing", "paused", "blocked", "completed"])

export const goalLedgerSubjects = [
  "current_goal_id",
  "current_goal_objective",
  "current_goal_status",
  "current_goal_iteration",
  "current_goal_acceptance_criteria",
  "current_goal_completion_checks",
  "current_goal_blocker",
] as const

export function createGoalState(objective: string): GoalState {
  const now = Date.now()
  return {
    id: `goal_${now.toString(36)}`,
    objective: objective.trim(),
    status: "defining",
    iteration: 1,
    acceptanceCriteria: [],
    completionChecks: [],
    startedAt: now,
    updatedAt: now,
  }
}

export function goalStateFromContext(context: ContextManagerLike, previous?: GoalState): GoalState | undefined {
  const current = context.state.ledger?.current ?? []
  const goalID = currentValue(current, "current_goal_id")
  const objective = currentValue(current, "current_goal_objective")
  const status = currentValue(current, "current_goal_status")
  if (!goalID || !objective || !status || !goalStatuses.has(status as GoalStatus)) return undefined
  const iteration = Number.parseInt(currentValue(current, "current_goal_iteration") ?? "", 10)
  const acceptanceCriteria = parseListValue(currentValue(current, "current_goal_acceptance_criteria"))
  const completionChecks = parseListValue(currentValue(current, "current_goal_completion_checks"))
  const blocker = currentValue(current, "current_goal_blocker")
  const activePlanId = currentValue(current, "current_plan_id")
  return {
    id: goalID,
    objective,
    status: status as GoalStatus,
    iteration: Number.isFinite(iteration) && iteration > 0 ? iteration : previous?.iteration ?? 1,
    acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : previous?.acceptanceCriteria ?? [],
    completionChecks: completionChecks.length > 0 ? completionChecks : previous?.completionChecks ?? [],
    blocker: blocker && blocker !== "none" ? blocker : undefined,
    startedAt: previous?.id === goalID ? previous.startedAt : Date.now(),
    updatedAt: Date.now(),
    activePlanId: activePlanId && activePlanId !== "none" ? activePlanId : undefined,
    summary: previous?.id === goalID ? previous.summary : undefined,
  }
}

export function writeGoalState(context: ContextManagerLike, goal: GoalState) {
  const turn = context.state.messages.length
  context.updateLedger({
    current: [
      ledgerRecord("checkpoint", "current_goal_id", goal.id, "current", turn),
      ledgerRecord("checkpoint", "current_goal_objective", goal.objective, "current", turn),
      ledgerRecord("checkpoint", "current_goal_status", goal.status, "current", turn),
      ledgerRecord("checkpoint", "current_goal_iteration", String(goal.iteration), "current", turn),
      ledgerRecord("checkpoint", "current_goal_acceptance_criteria", formatListValue(goal.acceptanceCriteria), "current", turn),
      ledgerRecord("checkpoint", "current_goal_completion_checks", formatListValue(goal.completionChecks), "current", turn),
      ledgerRecord("checkpoint", "current_goal_blocker", goal.blocker ?? "none", "current", turn),
    ],
  })
}

export function clearGoalState(context: ContextManagerLike) {
  const turn = context.state.messages.length
  const current = context.state.ledger?.current ?? []
  const nextCurrent = current.filter((record) => !goalLedgerSubjects.includes(record.subject as (typeof goalLedgerSubjects)[number]))
  const resolved = current
    .filter((record) => goalLedgerSubjects.includes(record.subject as (typeof goalLedgerSubjects)[number]))
    .map((record) => ({ ...record, status: "resolved" as const, updatedAtTurn: turn }))
  context.setLedger({ current: nextCurrent, history: [...(context.state.ledger?.history ?? []), ...resolved] })
}

export function stripGoalLedger(ledger: StructuredContextLedger | ContextLedger | undefined): StructuredContextLedger | ContextLedger | undefined {
  if (!ledger) return ledger
  const current = (ledger.current ?? []).filter((record) => !goalLedgerSubjects.includes(record.subject as (typeof goalLedgerSubjects)[number]))
  const history = (ledger.history ?? []).filter((record) => !goalLedgerSubjects.includes(record.subject as (typeof goalLedgerSubjects)[number]))
  if (current.length === 0 && history.length === 0) return undefined
  return { current, history }
}

export function goalStatusText(goal: GoalState | undefined) {
  if (!goal) return "No active goal."
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Iteration: ${goal.iteration}`,
    `Active plan: ${goal.activePlanId ?? "none"}`,
    `Acceptance criteria: ${goal.acceptanceCriteria.length > 0 ? goal.acceptanceCriteria.length : "none"}`,
    `Completion checks: ${goal.completionChecks.length > 0 ? goal.completionChecks.length : "none"}`,
    `Blocker: ${goal.blocker ?? "none"}`,
  ].join("\n")
}

export function buildGoalDefinitionPrompt(goal: GoalState, reason?: string) {
  const lines = [
    `Goal objective: ${goal.objective}`,
    `Goal iteration: ${goal.iteration}`,
  ]
  if (reason) lines.push(`Definition reason: ${reason}`)
  lines.push(
    "Before creating any execution plan, define the goal acceptance contract.",
    "Inspect the repository only as much as needed to establish concrete completion standards.",
    "Then call goal_set_acceptance with:",
    "- acceptanceCriteria: the explicit conditions that must be true before this goal can be marked complete",
    "- completionChecks: the concrete review/verification checks that must run after each plan slice before deciding whether the goal is done or needs another plan",
    "Keep both lists concise, concrete, and testable.",
    "If the goal cannot be defined safely, call goal_blocked."
  )
  return lines.join("\n")
}

export function buildGoalPlanningPrompt(goal: GoalState, reason?: string) {
  const lines = [
    `Goal objective: ${goal.objective}`,
    `Goal iteration: ${goal.iteration}`,
    `Current blocker: ${goal.blocker ?? "none"}`,
    `Goal acceptance criteria:\n${formatBullets(goal.acceptanceCriteria)}`,
    `Goal completion checks:\n${formatBullets(goal.completionChecks)}`,
  ]
  if (reason) lines.push(`Planning reason: ${reason}`)
  lines.push(
    "Inspect the current repository state only as needed, then decide the next bounded slice for this goal.",
    "The proposed plan must move the goal measurably toward the listed acceptance criteria.",
    "You must do exactly one of the following:",
    "1. Call plan_exit with a small executable plan for the next slice.",
    "2. Call goal_complete if the objective is fully satisfied.",
    "3. Call goal_blocked if progress now depends on user input, a denied high-risk action, or no safe next step exists.",
    "If the slice will use subagents, include explicit Research, Delegation, and Review phases and name the intended subagent roles.",
    "Anti-pattern warning: before outputting a review/repair/optimization plan, check whether reviewer can be delegated. If the review can be split into bounded scopes such as Code Complete dimensions, file groups, type safety, error handling, or test coverage, delegate reviewer first and synthesize only its conclusion.",
    "The structured plan JSON must include a top-level lowRisk boolean. Use true only for conservative read-only low-risk slices; otherwise false.",
    "Keep the plan narrow, verifiable, and continuation-friendly."
  )
  return lines.join("\n")
}

export function buildGoalAssessmentPrompt(goal: GoalState, reason?: string) {
  const lines = [
    `Goal objective: ${goal.objective}`,
    `Goal iteration: ${goal.iteration}`,
    `Goal acceptance criteria:\n${formatBullets(goal.acceptanceCriteria)}`,
    `Goal completion checks:\n${formatBullets(goal.completionChecks)}`,
  ]
  if (reason) lines.push(`Assessment reason: ${reason}`)
  lines.push(
    "The latest plan slice has finished. Do not immediately start another plan or mark the goal complete.",
    "First review the current repository state and run whatever bounded verification or review work is needed to judge the goal against the acceptance criteria.",
    "Use the listed completion checks as the minimum review/verification bar.",
    "After that, you must do exactly one of the following:",
    "1. Call goal_complete only if every acceptance criterion is satisfied and review/verification found no remaining defect that blocks completion.",
    "2. Call plan_exit with the next bounded plan if the goal is not yet complete or if review found defects/gaps to fix.",
    "3. Call goal_blocked if safe progress now requires user input or an unavailable permission."
  )
  return lines.join("\n")
}

export function activateGoalPlan(goal: GoalState, planId: string) {
  return {
    ...goal,
    status: "executing" as const,
    iteration: goal.status === "reviewing" || goal.status === "paused" ? goal.iteration + 1 : goal.iteration,
    blocker: undefined,
    activePlanId: planId,
    updatedAt: Date.now(),
  }
}

export function assertGoalPhase(goal: GoalState | undefined, action: string, allowed: GoalStatus[]): GoalState {
  if (!goal) throw new GoalStateError(`No active goal for ${action}.`)
  if (allowed.includes(goal.status)) return goal
  throw new GoalStateError(`${action} may only be called during ${formatAllowedPhases(allowed)} (current: ${goal.status})`)
}

export function goalHasAcceptance(goal: GoalState | undefined) {
  return Boolean(goal && goal.acceptanceCriteria.length > 0 && goal.completionChecks.length > 0)
}

export function goalAcceptanceText(goal: GoalState | undefined) {
  if (!goal) return "No active goal."
  return [
    `Acceptance criteria:\n${formatBullets(goal.acceptanceCriteria)}`,
    `Completion checks:\n${formatBullets(goal.completionChecks)}`,
  ].join("\n")
}

function currentValue(records: NonNullable<ContextManagerLike["state"]["ledger"]>["current"], subject: string) {
  return records.find((record) => record.subject === subject && record.status === "current")?.value
}

function parseListValue(value: string | undefined) {
  if (!value || value === "none") return []
  return value.split("\n").map((item) => item.replace(/^\s*-\s*/, "").trim()).filter(Boolean)
}

function formatListValue(items: string[]) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "none"
}

function formatBullets(items: string[]) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none yet"
}

function formatAllowedPhases(allowed: GoalStatus[]) {
  if (allowed.length === 1) return `goal ${allowed[0]}`
  return `goal phases ${allowed.join(", ")}`
}
