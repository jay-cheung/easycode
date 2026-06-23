import type { AgentMode, Message } from "../message"
import type { GoalState } from "../goal"
import type { PermissionReply, PermissionRequest } from "../permission"
import type { SessionData, SessionSummary } from "../session"
import type { SessionSettings } from "../settings"
import type { SkillInfo } from "../skill"
import type { StoredExecutionPlan } from "../plans"
import type { ProviderReadiness } from "../provider"
import type { RunUiEvent } from "../ui/timeline"

export const sidecarProtocolVersion = 1
export type RunPromptMode = AgentMode | "goal"
export type RunPromptPermissionMode = "ask" | "auto-review"

export type SidecarMethod =
  | "initialize"
  | "listProviders"
  | "getProviderReadiness"
  | "listSkills"
  | "listSessions"
  | "loadSession"
  | "deleteSession"
  | "getGoalStatus"
  | "pauseGoal"
  | "resumeGoal"
  | "clearGoal"
  | "getPlanStatus"
  | "clearPlan"
  | "getSettings"
  | "updateSettings"
  | "executeSlashCommand"
  | "runPrompt"
  | "cancelRun"
  | "replyPermission"
  | "replyPlan"
  | "shutdown"

export type SidecarRequest = {
  id: string
  method: SidecarMethod
  params?: unknown
}

export type SidecarResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: SidecarErrorPayload }

export type SidecarErrorPayload = {
  code: string
  message: string
}

export type SidecarEventEnvelope = {
  type: "event"
  runId?: string
  event: SidecarEvent
}

export type SidecarEvent =
  | RunUiEvent
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "plan_approval_request"; markdown: string }
  | { type: "session_changed"; session: string }
  | { type: "fatal"; message: string }

export type InitializeParams = Partial<SessionSettings> & {
  root?: string
  session?: string
  protocolVersion?: number
}

export type RunPromptParams = {
  text: string
  session?: string
  mode?: RunPromptMode
  permissionMode?: RunPromptPermissionMode
  images?: string[]
  files?: string[]
}

export type ExecuteSlashCommandParams = {
  text: string
  pendingImages?: number
  pendingFiles?: number
}

export type UpdateSettingsParams = Partial<SessionSettings> & {
  session?: string
}

export type ReplyPermissionParams = {
  requestId: string
  reply: PermissionReply
}

export type ReplyPlanParams = {
  runId: string
  action: "approve" | "reject" | "edit" | "new_prompt"
  text?: string
}

export type SidecarInitializeResult = {
  protocolVersion: typeof sidecarProtocolVersion
  root: string
  session: string
  settings: SessionSettings
}

export type SidecarLoadSessionResult = {
  session?: SessionData
  messages: Message[]
  settings: SessionSettings
}

export type SidecarListSessionsResult = {
  sessions: SessionSummary[]
  currentSession: string
}

export type SidecarListSkillsResult = {
  skills: Array<Pick<SkillInfo, "id" | "name" | "description" | "location">>
  selectedSkills: string[]
  pendingSkillLoads: string[]
}

export type SidecarProviderReadinessResult = ProviderReadiness

export type SidecarGoalStatusResult = {
  goal?: GoalState
  text: string
}

export type SidecarPlanStatusResult = {
  planId?: string
  plan?: StoredExecutionPlan
  status?: string
  currentStepId?: string
  blocker?: string
  text: string
}

export type SidecarSlashCommandResult =
  | { handled: false; promptText: string; mode?: RunPromptMode }
  | {
    handled: true
    title: string
    text: string
    settings?: SessionSettings
    session?: string
    action?: { type: "resumeGoal" } | { type: "addImage"; path: string; label: string } | { type: "clearImages" } | { type: "addFile"; path: string; label: string } | { type: "clearFiles" }
  }
