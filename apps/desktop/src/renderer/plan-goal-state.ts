import type { DesktopGoalState, DesktopPlanStatusResult } from "../shared/protocol.js"

export type DesktopRunStatus = "idle" | "running" | "waiting_plan" | "waiting_permission" | "done" | "failed" | "cancelled"

export type GoalLifecycleEvent = {
  type: "goal"
  phase: string
  goal?: DesktopGoalState
}

export type GoalControlResult = {
  cleared?: boolean
  paused?: boolean
  goal?: DesktopGoalState
  status?: string
  text?: string
}

export type PlanControlResult = {
  cleared?: boolean
  text?: string
}

export type PlanReplyAction = "approve" | "reject" | "edit" | "new_prompt"

export function planReplyDraft(draft: string) {
  return draft.trim()
}

export function canSubmitPlanDraft(draft: string) {
  return planReplyDraft(draft).length > 0
}

export function planReplyPayload(action: PlanReplyAction, draft = ""): { action: PlanReplyAction; text?: string } {
  if (action === "approve" || action === "reject") return { action }
  const text = planReplyDraft(draft)
  if (!text) throw new Error("Plan reply text is required.")
  return action === "edit" ? { action, text: `Revise the plan: ${text}` } : { action, text }
}

export function goalAfterLifecycleEvent(current: DesktopGoalState | undefined, event: GoalLifecycleEvent) {
  if (event.phase === "cleared") return undefined
  return event.goal ?? current
}

export function runStatusForGoalPhase(phase: string): DesktopRunStatus {
  if (phase === "blocked") return "failed"
  if (phase === "paused") return "cancelled"
  if (phase === "completed") return "done"
  if (phase === "cleared") return "idle"
  return "running"
}

export function goalLifecycleSummary(event: GoalLifecycleEvent) {
  const objective = event.goal?.objective ? `: ${event.goal.objective}` : ""
  return `Goal ${event.phase}${objective}`
}

export function planStatusFromResult(result: DesktopPlanStatusResult) {
  return result.planId ? result : undefined
}

export function goalFromControlResult(result: GoalControlResult) {
  return result.goal
}

export function goalAfterControlResult(current: DesktopGoalState | undefined, result: GoalControlResult) {
  if (result.cleared) return undefined
  if (Object.prototype.hasOwnProperty.call(result, "goal")) return result.goal
  if (result.text === "No active goal.") return undefined
  return current
}

export function planStatusAfterControlResult(current: DesktopPlanStatusResult | undefined, result: PlanControlResult) {
  if (result.cleared) return undefined
  if (result.text === "No active plan.") return undefined
  return current
}

export function runStatusFromGoalControlResult(result: GoalControlResult, fallback: DesktopRunStatus): DesktopRunStatus {
  if (result.status === "cancelled") return "cancelled"
  if (result.status === "completed") return "done"
  if (result.status === "failed" || result.status === "blocked") return "failed"
  return fallback
}

export function runStatusFromRunDone(status: string): DesktopRunStatus {
  if (status === "cancelled") return "cancelled"
  if (status === "failed" || status === "blocked") return "failed"
  return "done"
}

export function shouldReloadSessionAfterGoalControl(result: GoalControlResult) {
  return result.status === "completed" || result.status === "cancelled" || result.status === "failed" || Boolean(result.cleared || result.paused || result.text)
}

export function shouldReloadSessionAfterPlanControl(result: PlanControlResult) {
  return Boolean(result.cleared || result.text)
}

export function shouldReloadSessionAfterRunDone(status: string) {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "blocked"
}

export function shouldReloadSessionAfterGoalLifecycle(phase: string) {
  return phase === "completed" || phase === "blocked" || phase === "paused" || phase === "cleared"
}

export function shouldClearBlockingPromptsAfterRunDone(status: string) {
  return shouldReloadSessionAfterRunDone(status)
}
