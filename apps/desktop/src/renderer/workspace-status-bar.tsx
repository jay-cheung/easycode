import type { DesktopGoalState, DesktopPlanStatusResult, DesktopWorkspaceStatus } from "../shared/protocol.js"
import type { Progress } from "./app-types.js"
import { runProgressLabel, type RunProgressStatus, type RunStage } from "./run-progress.js"

type WorkspaceStatusCopy = {
  changedFiles: (count: number) => string
  clean: string
  goal: string
  goalIteration: (status: string, iteration: number) => string
  noActivePlan: string
  runStageLabel: (stage: RunStage) => string
  runStatus: (status: RunProgressStatus) => string
  showGitChanges: string
  stepProgress: (current: number, total: number) => string
}

export function WorkspaceChangesBar({
  copy,
  goal,
  onOpen,
  planStatus,
  progress,
  status,
}: {
  copy: WorkspaceStatusCopy
  goal?: DesktopGoalState
  onOpen: () => void
  planStatus?: DesktopPlanStatusResult
  progress?: Progress
  status?: DesktopWorkspaceStatus
}) {
  const plan = planStatus?.planId ? planProgressSnapshot(planStatus) : undefined
  const progressLabel = runProgressLabel(progress, copy)
  if (!status && !plan && !goal && !progressLabel) return null
  const changedStatus = status && !status.clean ? status : undefined
  const stepNumber = plan ? Math.max(1, Math.min(plan.total || 1, plan.currentIndex >= 0 ? plan.currentIndex + 1 : plan.completed || 1)) : 0
  return <div className="workspace-changes-bar">
    <button className={changedStatus ? "changed" : "clean"} onClick={onOpen} title={progressLabel ? progress?.summary : copy.showGitChanges}>
      {progressLabel && <><span className={`run-inline-dot ${progress?.status ?? "idle"}`} /><span>{progressLabel}</span>{(goal || plan || status) && <span className="status-separator">·</span>}</>}
      {goal && <><span className="goal-inline-label">{copy.goal}</span><span className="goal-inline-objective">{goal.objective}</span><span className="status-separator">·</span></>}
      {plan && <><span className={`plan-inline-dot ${plan.status}`} /><span>{copy.stepProgress(stepNumber, plan.total || stepNumber)}</span><span className="status-separator">·</span></>}
      {status && <span>{status.clean ? copy.clean : copy.changedFiles(status.changedFiles)}</span>}
      {changedStatus && <><strong>+{changedStatus.added}</strong><em>-{changedStatus.deleted}</em></>}
    </button>
    {(goal || plan) && <div className="workspace-plan-popover">
      {goal && <div className="status-goal-summary">
        <strong>{goal.objective}</strong>
        <span>{copy.goalIteration(goal.status, goal.iteration)}</span>
      </div>}
      {plan ? plan.steps.map((step, index) => {
        const status = plan.stepStatuses[step.id] ?? "pending"
        return <div className={`status-plan-step ${status}`} key={step.id}>
          <span>{status === "completed" ? "✓" : index === plan.currentIndex ? "" : index + 1}</span>
          <p>{step.goal}</p>
        </div>
      }) : <div className="status-plan-step pending"><span>·</span><p>{copy.noActivePlan}</p></div>}
    </div>}
  </div>
}

export function planProgressSnapshot(planStatus: DesktopPlanStatusResult) {
  const plan = planStatus.plan?.plan
  const checkpoint = planStatus.plan?.checkpoint
  const steps = plan?.steps ?? []
  const stepStatuses = checkpoint?.stepStatuses ?? {}
  const currentIndex = steps.findIndex((step) => step.id === (planStatus.currentStepId ?? checkpoint?.currentStepId))
  const completed = Object.values(stepStatuses).filter((status) => status === "completed").length
  const current = currentIndex >= 0 ? steps[currentIndex] : undefined
  return {
    completed,
    current,
    currentIndex,
    status: planStatus.status ?? checkpoint?.status ?? "active",
    stepStatuses,
    steps,
    title: plan?.title ?? planStatus.planId ?? "Plan",
    total: steps.length,
  }
}
