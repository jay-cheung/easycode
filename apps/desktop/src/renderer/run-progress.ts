export type RunStage = "preparing" | "connecting" | "thinking" | "responding" | "tool" | "permission" | "plan" | "cancelling"

export type RunProgressStatus = "idle" | "running" | "waiting_plan" | "waiting_permission" | "done" | "failed" | "blocked" | "cancelled"

export type RunProgressView = {
  status: RunProgressStatus
  stage?: RunStage
  summary: string
}

export type RunProgressCopy = {
  runStageLabel: (stage: RunStage) => string
  runStatus: (status: RunProgressStatus) => string
}

export function visibleRunProgress(progress: RunProgressView | undefined): progress is RunProgressView {
  if (!progress) return false
  return progress.status !== "idle" && progress.status !== "done"
}

export function runProgressLabel(progress: RunProgressView | undefined, copy: RunProgressCopy) {
  const current = progress
  if (!visibleRunProgress(current)) return undefined
  if (current.stage) return copy.runStageLabel(current.stage)
  return copy.runStatus(current.status)
}
