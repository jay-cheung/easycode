import type { AgentMode, ImagePart, Message } from "../message"
import type { PermissionService } from "../permission"
import type { Provider, ProviderName } from "../provider"
import type { Sandbox } from "../sandbox"
import type { SkillServiceLike } from "../skill"
import type { InstructionServiceLike } from "../instruction"
import type { ToolRegistryLike } from "../tool"
import type { ContextManagerLike } from "../context"
import type { Logger } from "../logger"
import type { RunAspect } from "../instrumentation"
import type { SessionSettings } from "../settings"
import type { RunUiEvent } from "../ui/timeline"

export type Agent = {
  name: string
  mode: AgentMode
  systemPrompt: string
}

export type AgentRunState = "idle" | "preparing" | "streaming" | "tool_pending" | "tool_running" | "completed" | "failed" | "cancelled"

export type AgentRunResult = {
  status: "completed" | "failed" | "cancelled"
  failureReason?: "provider_error" | "max_steps" | "cancelled"
  text: string
  reasoning?: string
  messages: Message[]
  usedTools: string[]
  state: AgentRunState
}

export type AgentRunnerOptions = {
  root: string
  provider: Provider
  registry?: ToolRegistryLike
  permission?: PermissionService
  context?: ContextManagerLike
  skills?: SkillServiceLike
  instructions?: InstructionServiceLike
  sandbox?: Sandbox
  maxSteps?: number
  logger?: Logger
  aspect?: RunAspect
  onTextDelta?: (text: string) => void
  onEvent?: (event: RunUiEvent) => void
  toolProgressIntervalMs?: number
  providerProgressIntervalMs?: number
  settings?: SessionSettings
}
