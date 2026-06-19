import type { AgentMode, Message } from "../message"
import type { PermissionReply, PermissionRequest } from "../permission"
import type { SessionData, SessionSummary } from "../session"
import type { SessionSettings } from "../settings"
import type { RunUiEvent } from "../ui/timeline"

export const sidecarProtocolVersion = 1

export type SidecarMethod =
  | "initialize"
  | "listSessions"
  | "loadSession"
  | "deleteSession"
  | "getSettings"
  | "updateSettings"
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
  mode?: AgentMode
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
}

export type SidecarListSessionsResult = {
  sessions: SessionSummary[]
  currentSession: string
}
