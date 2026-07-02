import type {
  DesktopMessagePart,
  DesktopPermissionMode,
  DesktopRunMode,
} from "../shared/protocol.js"
import type { DesktopAttachment } from "./attachment-state.js"
import type { RunStage } from "./run-progress.js"

export type ChatItem =
  | { id: string; kind: "user"; text: string; time: string }
  | { id: string; kind: "assistant"; text: string; time: string; pending?: boolean }
  | { id: string; kind: "tool"; title: string; detail: string; status: "running" | "done"; open: boolean }
  | { id: string; kind: "status"; text: string }

export type ToolItem = Extract<ChatItem, { kind: "tool" }>
export type MessageItem = Exclude<ChatItem, ToolItem>

export type AssistantTurnPart =
  | { id: string; kind: "assistant"; item: Extract<ChatItem, { kind: "assistant" }> }
  | { id: string; kind: "tools"; tools: ToolItem[] }

export type AssistantRenderPart =
  | AssistantTurnPart
  | { id: string; kind: "activity"; parts: AssistantTurnPart[] }

export type StreamEntry =
  | { id: string; kind: "message"; item: Exclude<MessageItem, { kind: "assistant" }> }
  | { id: string; kind: "assistantTurn"; time: string; parts: AssistantTurnPart[] }

export type PermissionMode = DesktopPermissionMode
export type PermissionPrompt = { requestId: string; title: string; detail: string; workspaceRoot?: string }
export type PlanPrompt = { runId: string; markdown: string; workspaceRoot?: string }
export type Attachment = DesktopAttachment
export type MarkdownFileOpenHandler = (filePath: string) => Promise<void>

export type RunStatus = "idle" | "running" | "waiting_plan" | "waiting_permission" | "done" | "failed" | "blocked" | "cancelled"
export type Progress = {
  status: RunStatus
  stage?: RunStage
  startedAt?: number
  summary: string
  provider?: string
  model?: string
  mode?: string
  toolCalls: number
  toolResults: number
}

export type RunMode = DesktopRunMode
export type SelectOption = { value: string; label: string }

export type ToolBackedMessagePart = Extract<DesktopMessagePart, { type: "tool_call" | "tool_result" }>
