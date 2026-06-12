import type { AgentMode, Message } from "../message"
import type { PermissionService } from "../permission"
import type { Provider } from "../provider"
import type { Sandbox } from "../sandbox"
import type { SkillServiceLike } from "../skill"
import type { InstructionServiceLike } from "../instruction"
import type { ToolRegistryLike } from "../tool"
import type { ContextManagerLike } from "../context"
import type { Logger } from "../logger"
import type { RunAspect } from "../instrumentation"
import type { SessionSettings } from "../settings"
import type { RunUiEvent } from "../ui/timeline"

export type SubagentRole = "summary" | "explorer" | "reviewer" | "debugger" | "tester" | "docs_researcher"

export type AgentKind = AgentMode | SubagentRole
export type AgentToolPolicy = "enabled" | "none"

export type Agent = {
  kind: AgentKind
  name: string
  role?: SubagentRole
  depth?: 0 | 1
  mode: AgentMode
  systemPrompt: string
  tools: AgentToolPolicy
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
  onBackgroundContextUpdate?: () => void | Promise<void>
  toolProgressIntervalMs?: number
  providerProgressIntervalMs?: number
  settings?: SessionSettings
  sessionId?: string
}
