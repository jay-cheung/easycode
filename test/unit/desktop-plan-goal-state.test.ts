import { describe, expect, test } from "bun:test"
import { canSubmitPlanDraft, goalAfterControlResult, goalAfterLifecycleEvent, goalFromControlResult, goalLifecycleSummary, planReplyDraft, planReplyPayload, planStatusAfterControlResult, planStatusFromResult, runStatusForGoalPhase, runStatusFromGoalControlResult, runStatusFromRunDone, shouldClearBlockingPromptsAfterRunDone, shouldReloadSessionAfterGoalControl, shouldReloadSessionAfterGoalLifecycle, shouldReloadSessionAfterPlanControl, shouldReloadSessionAfterRunDone } from "../../apps/desktop/src/renderer/plan-goal-state"

describe("desktop plan and goal state", () => {
  test("maps goal lifecycle events into visible goal and progress state", () => {
    const goal = { objective: "ship goal UI", status: "planning", iteration: 2 }

    expect(goalAfterLifecycleEvent(undefined, { type: "goal", phase: "planning", goal })).toEqual(goal)
    expect(goalAfterLifecycleEvent(goal, { type: "goal", phase: "cleared" })).toBeUndefined()
    expect(runStatusForGoalPhase("planning")).toBe("running")
    expect(runStatusForGoalPhase("paused")).toBe("cancelled")
    expect(runStatusForGoalPhase("blocked")).toBe("blocked")
    expect(runStatusForGoalPhase("completed")).toBe("done")
    expect(goalLifecycleSummary({ type: "goal", phase: "planning", goal })).toBe("Goal planning: ship goal UI")
  })

  test("keeps plan state only when the sidecar reports an active plan", () => {
    const active = { planId: "plan_1", status: "running", text: "Plan: plan_1" }

    expect(planStatusFromResult(active)).toBe(active)
    expect(planStatusFromResult({ text: "No active plan." })).toBeUndefined()
  })

  test("maps goal control responses without inventing state", () => {
    const goal = { objective: "resume safely", status: "paused", iteration: 1 }

    expect(goalFromControlResult({ goal })).toBe(goal)
    expect(goalFromControlResult({ text: "No active goal." })).toBeUndefined()
    expect(goalAfterControlResult(goal, { goal: { objective: "resume safely", status: "planning", iteration: 2 } })).toEqual({ objective: "resume safely", status: "planning", iteration: 2 })
    expect(goalAfterControlResult(goal, { cleared: true, text: "Goal cleared." })).toBeUndefined()
    expect(goalAfterControlResult(goal, { text: "No active goal." })).toBeUndefined()
    expect(goalAfterControlResult(goal, { text: "Goal paused." })).toBe(goal)
    expect(runStatusFromGoalControlResult({ status: "completed" }, "running")).toBe("done")
    expect(runStatusFromGoalControlResult({ status: "blocked" }, "running")).toBe("blocked")
    expect(runStatusFromGoalControlResult({ status: "planning" }, "running")).toBe("running")
    expect(shouldReloadSessionAfterGoalControl({ status: "completed" })).toBe(true)
    expect(shouldReloadSessionAfterGoalControl({ text: "Goal paused." })).toBe(true)
    expect(shouldReloadSessionAfterGoalControl({ cleared: true })).toBe(true)
    expect(shouldReloadSessionAfterGoalControl({ paused: true })).toBe(true)
    expect(shouldReloadSessionAfterGoalControl({})).toBe(false)
  })

  test("reloads persisted session messages after plan controls and run completion", () => {
    const activePlan = { planId: "plan_1", status: "running", text: "Plan: plan_1" }

    expect(planStatusAfterControlResult(activePlan, { cleared: true, text: "Plan cleared." })).toBeUndefined()
    expect(planStatusAfterControlResult(activePlan, { text: "No active plan." })).toBeUndefined()
    expect(planStatusAfterControlResult(activePlan, { text: "Plan still active." })).toBe(activePlan)
    expect(shouldReloadSessionAfterPlanControl({ cleared: true })).toBe(true)
    expect(shouldReloadSessionAfterPlanControl({ text: "Plan cleared." })).toBe(true)
    expect(shouldReloadSessionAfterPlanControl({})).toBe(false)
    expect(shouldReloadSessionAfterRunDone("completed")).toBe(true)
    expect(shouldReloadSessionAfterRunDone("cancelled")).toBe(true)
    expect(shouldReloadSessionAfterRunDone("failed")).toBe(true)
    expect(shouldReloadSessionAfterRunDone("running")).toBe(false)
  })

  test("clears visible plan and goal state after explicit desktop clear controls", () => {
    const goal = { objective: "ship desktop goal", status: "planning", iteration: 1 }
    const plan = { planId: "plan_desktop", status: "running", text: "Plan: desktop" }

    expect(goalAfterControlResult(goal, { cleared: true, text: "Goal cleared." })).toBeUndefined()
    expect(shouldReloadSessionAfterGoalControl({ cleared: true, text: "Goal cleared." })).toBe(true)
    expect(planStatusAfterControlResult(plan, { cleared: true, text: "Plan cleared." })).toBeUndefined()
    expect(shouldReloadSessionAfterPlanControl({ cleared: true, text: "Plan cleared." })).toBe(true)
    expect(planStatusFromResult({ text: "No active plan." })).toBeUndefined()
    expect(goalAfterLifecycleEvent(goal, { type: "goal", phase: "cleared" })).toBeUndefined()
    expect(runStatusForGoalPhase("cleared")).toBe("idle")
  })

  test("reloads persisted session and status after terminal goal lifecycle phases", () => {
    expect(shouldReloadSessionAfterGoalLifecycle("completed")).toBe(true)
    expect(shouldReloadSessionAfterGoalLifecycle("blocked")).toBe(true)
    expect(shouldReloadSessionAfterGoalLifecycle("paused")).toBe(true)
    expect(shouldReloadSessionAfterGoalLifecycle("cleared")).toBe(true)
    expect(shouldReloadSessionAfterGoalLifecycle("started")).toBe(false)
    expect(shouldReloadSessionAfterGoalLifecycle("planning")).toBe(false)
    expect(shouldReloadSessionAfterGoalLifecycle("executing")).toBe(false)
  })

  test("maps sidecar run_done statuses into visible progress states", () => {
    expect(runStatusFromRunDone("completed")).toBe("done")
    expect(runStatusFromRunDone("cancelled")).toBe("cancelled")
    expect(runStatusFromRunDone("failed")).toBe("failed")
    expect(runStatusFromRunDone("blocked")).toBe("blocked")
  })

  test("clears blocking approval prompts after terminal run completion", () => {
    expect(shouldClearBlockingPromptsAfterRunDone("completed")).toBe(true)
    expect(shouldClearBlockingPromptsAfterRunDone("cancelled")).toBe(true)
    expect(shouldClearBlockingPromptsAfterRunDone("failed")).toBe(true)
    expect(shouldClearBlockingPromptsAfterRunDone("blocked")).toBe(true)
    expect(shouldClearBlockingPromptsAfterRunDone("running")).toBe(false)
  })

  test("builds plan reply payloads from explicit UI intents", () => {
    expect(planReplyDraft("  add tests  ")).toBe("add tests")
    expect(canSubmitPlanDraft("  ")).toBe(false)
    expect(canSubmitPlanDraft(" revise ")).toBe(true)
    expect(planReplyPayload("approve")).toEqual({ action: "approve" })
    expect(planReplyPayload("reject")).toEqual({ action: "reject" })
    expect(planReplyPayload("new_prompt", "  rebuild the plan  ")).toEqual({ action: "new_prompt", text: "rebuild the plan" })
    expect(planReplyPayload("edit", " add tests first ")).toEqual({ action: "edit", text: "Revise the plan: add tests first" })
    expect(() => planReplyPayload("edit", " ")).toThrow("Plan reply text is required.")
  })
})
