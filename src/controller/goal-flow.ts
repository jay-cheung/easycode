import { hasProposedPlanText } from "../agent"
import { PlanTracker } from "../agent/planner"
import type { ContextManagerLike } from "../context"
import { activateGoalPlan, buildGoalAssessmentPrompt, buildGoalDefinitionPrompt, buildGoalPlanningPrompt, clearGoalState, createGoalState, goalHasAcceptance, goalStateFromContext, goalStatusText, writeGoalState, type GoalState } from "../goal"
import { emitLog, type Logger } from "../logger"
import type { AgentMode } from "../message"
import { savePlan } from "../plans"
import type { RunUiEvent } from "../ui/timeline"
import { currentPlanBlocker, currentPlanID, currentPlanStatus, firstDeniedToolResult, latestGoalAcceptanceResult, latestGoalToolResult, shouldCompleteReadOnlyGoalPlanningResult, toolResultsSince } from "./goal-helpers"

export type QueuedControllerPrompt = {
  text: string
  mode: AgentMode
}

export type ControllerRunResult = {
  status: string
  text: string
}

export type GoalFlowResult =
  | { type: "next"; prompt: QueuedControllerPrompt }
  | { type: "finished"; status: string; text: string }

export class GoalFlowController {
  private goalState: GoalState | undefined

  constructor(private readonly input: {
    root: string
    session: string
    context: ContextManagerLike
    logger?: Logger
    onEvent?: (event: RunUiEvent) => void
    writeMessage?: (text: string) => void
  }) {
    this.goalState = goalStateFromContext(input.context)
  }

  activeGoalAutomation() {
    return Boolean(this.goalState && (this.goalState.status === "defining" || this.goalState.status === "planning" || this.goalState.status === "executing" || this.goalState.status === "reviewing"))
  }

  current() {
    this.syncGoalFromContext()
    return this.goalState
  }

  statusText() {
    return goalStatusText(this.current())
  }

  async start(objective: string): Promise<QueuedControllerPrompt> {
    await this.clearActivePlanIfPresent()
    const nextGoal = createGoalState(objective)
    this.emitGoalLifecycle("goal.started", nextGoal)
    const prompt = this.beginGoalDefinition(nextGoal, "Goal started by user. Define acceptance before any plan.")
    this.input.writeMessage?.(`Goal started.\n${goalStatusText(this.goalState)}`)
    return prompt
  }

  async clear() {
    await this.clearActivePlanIfPresent()
    this.emitGoalLifecycle("goal.cleared", this.goalState)
    this.persistGoal(undefined)
    this.input.writeMessage?.("Goal cleared.")
  }

  async pause(reason?: string) {
    this.syncGoalFromContext()
    if (!this.goalState) {
      this.input.writeMessage?.("No active goal.")
      return
    }
    await this.finishPaused(reason ?? this.goalState.blocker ?? "Paused by user.")
  }

  resume(): QueuedControllerPrompt | undefined {
    this.syncGoalFromContext()
    if (!this.goalState) {
      this.input.writeMessage?.("No active goal.")
      return undefined
    }
    if (!goalHasAcceptance(this.goalState)) return this.beginGoalDefinition(this.goalState, "Goal resumed by user. Define acceptance before planning.")
    return this.beginGoalPlanning(this.goalState, "Goal resumed by user.")
  }

  async handleRunResult(input: { result: ControllerRunResult; messageCountBeforeRun: number }): Promise<GoalFlowResult> {
    this.syncGoalFromContext()
    if (!this.goalState) return { type: "finished", status: input.result.status, text: input.result.text }

    const recentToolResults = toolResultsSince(this.input.context.state.messages, input.messageCountBeforeRun)
    const goalAcceptanceResult = latestGoalAcceptanceResult(recentToolResults)
    const goalToolResult = latestGoalToolResult(recentToolResults)
    const deniedToolResult = firstDeniedToolResult(recentToolResults)
    const activePlanId = currentPlanID(this.input.context)
    const planStatus = currentPlanStatus(this.input.context)
    const planBlocker = currentPlanBlocker(this.input.context)

    if (input.result.status === "completed" && hasProposedPlanText(input.result.text)) {
      await savePlan(this.input.root, this.input.session, input.result.text)
      if (this.goalState.status === "planning" || this.goalState.status === "reviewing") {
        if (!activePlanId) return await this.finishBlocked("Goal planning returned a proposed plan, but no structured active plan was created.")
        this.persistGoal(activateGoalPlan(this.goalState, activePlanId))
        this.emitGoalLifecycle("goal.executing", this.goalState, { planId: activePlanId })
        return { type: "next", prompt: { text: "Proceed with the approved plan.", mode: "build" } }
      }
    }

    if (goalAcceptanceResult) {
      this.syncGoalFromContext()
      if (!this.goalState || !goalHasAcceptance(this.goalState)) return await this.finishBlocked("Goal acceptance recording finished without durable acceptance criteria.")
      return { type: "next", prompt: this.beginGoalPlanning(this.goalState, "Goal acceptance criteria were recorded. Plan the first bounded slice.") }
    }
    if (goalToolResult?.toolName === "goal_complete") {
      return this.finishCompleted(String(goalToolResult.metadata.summary ?? goalToolResult.output).trim() || "Goal completed.")
    }
    if (goalToolResult?.toolName === "goal_blocked") {
      return await this.finishBlocked(String(goalToolResult.metadata.reason ?? goalToolResult.output).trim() || "Goal blocked.")
    }
    if (deniedToolResult && this.activeGoalAutomation()) {
      return await this.finishPaused(`Permission denied for ${deniedToolResult.toolName}. Resume after user intervention or revise the goal plan.`)
    }
    if (planStatus === "blocked" && (this.goalState.status === "planning" || this.goalState.status === "executing" || this.goalState.status === "reviewing")) {
      return await this.finishBlocked(planBlocker ?? "The active goal plan became blocked.")
    }
    if (input.result.status === "completed" && this.goalState.status === "defining") {
      return await this.finishBlocked("Goal definition ended without recording acceptance criteria or an explicit blocked state.")
    }
    if (input.result.status === "completed" && shouldCompleteReadOnlyGoalPlanningResult(this.goalState, input.result.text, recentToolResults)) {
      return this.finishCompleted(input.result.text.trim())
    }
    if (input.result.status === "completed" && this.goalState.status === "planning") {
      return await this.finishBlocked("Goal planning ended without a proposed plan or an explicit goal resolution.")
    }
    if (input.result.status === "completed" && this.goalState.status === "executing" && !activePlanId) {
      return { type: "next", prompt: this.beginGoalReview(this.goalState, "The previous goal slice completed. Review and verify the goal before deciding whether to complete it or plan the next slice.") }
    }
    if (input.result.status === "completed" && this.goalState.status === "reviewing") {
      return await this.finishBlocked("Goal review ended without a completion decision or a next bounded plan.")
    }
    return { type: "finished", status: input.result.status, text: input.result.text }
  }

  private syncGoalFromContext() {
    this.goalState = goalStateFromContext(this.input.context, this.goalState)
  }

  private emitGoalLifecycle(name: string, goal: GoalState | undefined, extra: Record<string, unknown> = {}) {
    if (!goal) return
    const phase = name.startsWith("goal.") ? name.slice(5) : name
    emitLog(this.input.logger, {
      type: "state",
      name,
      detail: {
        goalId: goal.id,
        objective: goal.objective,
        status: goal.status,
        iteration: goal.iteration,
        activePlanId: goal.activePlanId,
        blocker: goal.blocker,
        acceptanceCriteriaCount: goal.acceptanceCriteria.length,
        completionChecksCount: goal.completionChecks.length,
        ...extra,
      },
    })
    this.input.onEvent?.({
      type: "goal",
      phase: phase as "started" | "definition" | "planning" | "executing" | "reviewing" | "paused" | "blocked" | "completed" | "cleared",
      goal: {
        status: goal.status,
        objective: goal.objective,
        iteration: goal.iteration,
        activePlanId: goal.activePlanId,
        blocker: goal.blocker,
      },
    })
  }

  private persistGoal(next: GoalState | undefined) {
    this.goalState = next
    if (this.goalState) {
      this.goalState = { ...this.goalState, activePlanId: currentPlanID(this.input.context), updatedAt: Date.now() }
      writeGoalState(this.input.context, this.goalState)
    } else {
      clearGoalState(this.input.context)
    }
  }

  private async clearActivePlanIfPresent() {
    const planId = currentPlanID(this.input.context)
    if (planId) await PlanTracker.clearActivePlan(this.input.context, this.input.root, planId)
  }

  private beginGoalDefinition(goal: GoalState, reason?: string): QueuedControllerPrompt {
    this.persistGoal({ ...goal, status: "defining", blocker: undefined, activePlanId: undefined })
    this.emitGoalLifecycle("goal.definition", this.goalState, reason ? { reason } : {})
    return { text: buildGoalDefinitionPrompt(this.goalState ?? goal, reason), mode: "build" }
  }

  private beginGoalPlanning(goal: GoalState, reason?: string, advanceIteration = false): QueuedControllerPrompt {
    this.persistGoal({ ...goal, status: "planning", blocker: undefined, iteration: advanceIteration ? goal.iteration + 1 : goal.iteration, activePlanId: undefined })
    this.emitGoalLifecycle("goal.planning", this.goalState, { ...(reason ? { reason } : {}), advanceIteration })
    return { text: buildGoalPlanningPrompt(this.goalState ?? goal, reason), mode: "plan" }
  }

  private beginGoalReview(goal: GoalState, reason?: string): QueuedControllerPrompt {
    this.persistGoal({ ...goal, status: "reviewing", blocker: undefined, activePlanId: undefined })
    this.emitGoalLifecycle("goal.reviewing", this.goalState, reason ? { reason } : {})
    return { text: buildGoalAssessmentPrompt(this.goalState ?? goal, reason), mode: "build" }
  }

  private async finishPaused(reason: string): Promise<GoalFlowResult> {
    if (!this.goalState) return { type: "finished", status: "paused", text: reason }
    await this.clearActivePlanIfPresent()
    this.persistGoal({ ...this.goalState, status: "paused", blocker: reason, activePlanId: undefined })
    this.emitGoalLifecycle("goal.paused", this.goalState, { reason })
    const text = `Goal paused.\n${goalStatusText(this.goalState)}`
    this.input.writeMessage?.(text)
    return { type: "finished", status: "paused", text }
  }

  private async finishBlocked(reason: string): Promise<GoalFlowResult> {
    if (!this.goalState) return { type: "finished", status: "blocked", text: reason }
    await this.clearActivePlanIfPresent()
    this.persistGoal({ ...this.goalState, status: "blocked", blocker: reason, activePlanId: undefined })
    this.emitGoalLifecycle("goal.blocked", this.goalState, { reason })
    const text = `Goal blocked.\n${goalStatusText(this.goalState)}`
    this.input.writeMessage?.(text)
    return { type: "finished", status: "blocked", text }
  }

  private finishCompleted(summary: string): GoalFlowResult {
    if (!this.goalState) return { type: "finished", status: "completed", text: summary }
    this.persistGoal({ ...this.goalState, status: "completed", blocker: undefined, summary, activePlanId: undefined })
    this.emitGoalLifecycle("goal.completed", this.goalState, { summary })
    const text = `Goal completed.\n${summary}`
    this.input.writeMessage?.(text)
    return { type: "finished", status: "completed", text }
  }
}
