import { describe, expect, test } from "bun:test"
import { GoalStateError, activateGoalPlan, assertGoalPhase, buildGoalAssessmentPrompt, buildGoalDefinitionPrompt, buildGoalPlanningPrompt, createGoalState, transitionGoalState } from "../../src/goal"

describe("goal prompt", () => {
  test("goal definition prompt requires acceptance criteria before planning", () => {
    const goal = createGoalState("Implement delegated goal slices")
    const prompt = buildGoalDefinitionPrompt(goal, "Goal started by user.")

    expect(prompt).toContain("Before creating any execution plan, classify the task complexity and define only the next useful goal slice.")
    expect(prompt).toContain("Do not attempt exhaustive repository understanding before the first plan.")
    expect(prompt).toContain("complexity: simple, moderate, or complex")
    expect(prompt).toContain("firstSlice")
    expect(prompt).toContain("call goal_set_acceptance")
    expect(prompt).toContain("completionChecks")
  })

  test("goal planning prompt keeps the run in proposal-plan mode", () => {
    const goal = createGoalState("Implement delegated goal slices")
    goal.complexity = "complex"
    goal.firstSlice = "Inspect the smallest runner module first"
    goal.acceptanceCriteria = ["The delegated slice completes safely"]
    goal.completionChecks = ["Run review and focused verification after each plan slice"]
    const prompt = buildGoalPlanningPrompt(goal, "Goal started by user.")

    expect(prompt).toContain("Goal complexity: complex")
    expect(prompt).toContain("First slice focus: Inspect the smallest runner module first")
    expect(prompt).toContain("Goal acceptance criteria:")
    expect(prompt).toContain("Goal completion checks:")
    expect(prompt).toContain("Inspect the current repository state only as needed for the next bounded slice.")
    expect(prompt).toContain("do not try to produce a complete end-to-end master plan")
    expect(prompt).toContain("Call plan_exit with a small executable plan")
    expect(prompt).toContain("include explicit Research, Delegation, and Review phases")
  })

  test("goal assessment prompt requires review before completion or replanning", () => {
    const goal = createGoalState("Implement delegated goal slices")
    goal.complexity = "complex"
    goal.firstSlice = "Inspect the smallest runner module first"
    goal.acceptanceCriteria = ["The delegated slice completes safely"]
    goal.completionChecks = ["Run review and focused verification after each plan slice"]
    const prompt = buildGoalAssessmentPrompt(goal, "The plan slice completed.")

    expect(prompt).toContain("The latest plan slice has finished.")
    expect(prompt).toContain("Use the listed completion checks as the minimum review/verification bar.")
    expect(prompt).toContain("otherwise propose exactly one next bounded slice")
    expect(prompt).toContain("Call goal_complete only if every acceptance criterion is satisfied")
    expect(prompt).toContain("Call plan_exit with the next bounded plan")
  })

  test("activating the first goal plan keeps the initial iteration and activating from review or pause advances it", () => {
    const goal = createGoalState("Implement delegated goal slices")

    const firstExecution = activateGoalPlan({ ...goal, status: "planning" }, "plan_1")
    const secondExecution = activateGoalPlan({ ...goal, status: "reviewing" }, "plan_2")
    const resumedExecution = activateGoalPlan({ ...goal, status: "paused", iteration: 3 }, "plan_3")

    expect(firstExecution.iteration).toBe(1)
    expect(firstExecution.status).toBe("executing")
    expect(firstExecution.activePlanId).toBe("plan_1")
    expect(secondExecution.iteration).toBe(2)
    expect(secondExecution.status).toBe("executing")
    expect(secondExecution.activePlanId).toBe("plan_2")
    expect(resumedExecution.iteration).toBe(4)
    expect(resumedExecution.status).toBe("executing")
    expect(resumedExecution.activePlanId).toBe("plan_3")
  })

  test("goal phase assertions fail closed outside the allowed lifecycle stage", () => {
    const goal = createGoalState("Implement delegated goal slices")

    expect(assertGoalPhase(goal, "goal_set_acceptance", ["defining"])).toBe(goal)
    expect(() => assertGoalPhase({ ...goal, status: "reviewing" }, "goal_set_acceptance", ["defining"])).toThrow(GoalStateError)
  })

  test("goal transitions fail closed on invalid lifecycle jumps", () => {
    const goal = createGoalState("Implement delegated goal slices")

    const planning = transitionGoalState(goal, "planning", {
      acceptanceCriteria: ["The slice is complete"],
      completionChecks: ["Focused verification passed"],
    })

    expect(planning.status).toBe("planning")
    expect(() => activateGoalPlan(goal, "plan_unsafe")).toThrow(GoalStateError)
    expect(() => transitionGoalState({ ...goal, status: "completed" }, "executing")).toThrow(GoalStateError)
  })
})
