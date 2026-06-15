import type { ToolCall } from "../message"
import type { ToolDef } from "../tool"
import type { ToolResult } from "../tool/registry"
import type { SubagentRole } from "./types"

export type SubagentRequest = {
  role: SubagentRole
  task: string
  successCriteria?: string
}

export type SubagentExecutionStatus = "succeeded" | "handoff" | "failed"

export type SubagentExecutionResult = {
  role: SubagentRole
  status: SubagentExecutionStatus
  summary: string
  findings?: string[]
  artifacts?: string[]
  nextAction?: string
}

export type SubagentAssignedStep = {
  planId: string
  stepId: string
  goal: string
  doneWhen?: string
}

export type SubagentTaskPacket = {
  requestId: number
  role: SubagentRole
  task: string
  successCriteria?: string
  maxProviderCalls: number
  assignedStep?: SubagentAssignedStep
}

export type SubagentTaskState = {
  packet: SubagentTaskPacket
  turnsUsed: number
  lastAssistantText?: string
  findings: string[]
  artifacts: string[]
  blockedActions: string[]
}

export type SubagentBudgetSnapshot = {
  totalInvocationLimit: number
  totalTurnLimit: number
  usedInvocations: number
  usedTurns: number
  reservedTurns: number
  roleInvocationLimit: number
  roleInvocations: number
}

export const subagentInvocationLimits: Record<SubagentRole, number> = {
  summary: 2,
  explorer: 2,
  reviewer: 1,
  debugger: 2,
  tester: 2,
  docs_researcher: 1,
}

export const maxSubagentInvocationsPerRun = 6
export const maxSubagentTurnsPerRun = 15

const coordinatorOnlyToolNames = new Set(["delegate_subagent", "plan_exit", "plan_step_complete", "plan_step_fail"])
const writeToolNames = new Set(["patch", "write", "edit", "memory_add", "memory_promote", "git_stage", "git_commit", "git_restore_guarded", "git_branch", "connector_call"])
const readOnlySubagentToolNames = new Set([
  "read",
  "list",
  "grep",
  "rg_search",
  "read_lines",
  "find_definition",
  "find_references",
  "call_graph",
  "repo_map",
  "ledger",
  "memory_query",
  "git_diff",
  "git_status",
  "git_log",
  "mcp_list_resources",
  "mcp_read_resource",
  "web_search",
  "web_fetch",
  "skill",
  "connector_list",
])
const activeDebugToolNames = new Set(["bash"])
const docsResearchToolNames = new Set(["web_search", "web_fetch", "mcp_list_resources", "mcp_read_resource", "connector_list"])
const pureFactFindingToolNames = new Set([
  "repo_map",
  "find_definition",
  "find_references",
  "call_graph",
  "rg_search",
  "grep",
  "read",
  "read_lines",
  "list",
  "git_diff",
  "git_status",
  "git_log",
])
const delegatedCoordinatorToolNames = new Set([...docsResearchToolNames, ...pureFactFindingToolNames])
const delegatedSearchToolNames = new Set(["repo_map", "find_definition", "find_references", "call_graph", "rg_search", "grep"])

export function roleInvocationLimit(role: SubagentRole) {
  return subagentInvocationLimits[role]
}

export function isCoordinatorOnlyTool(name: string) {
  return coordinatorOnlyToolNames.has(name)
}

export function isSubagentToolAllowed(role: SubagentRole, name: string) {
  if (isCoordinatorOnlyTool(name)) return false
  if (writeToolNames.has(name)) return false
  if (role === "debugger" || role === "tester") return readOnlySubagentToolNames.has(name) || activeDebugToolNames.has(name)
  return readOnlySubagentToolNames.has(name)
}

export function filterToolsForAgent(tools: ToolDef[], input: { role?: SubagentRole; depth: 0 | 1 }) {
  if (input.depth === 0) return tools
  if (!input.role) return tools.filter((tool) => !isCoordinatorOnlyTool(tool.name))
  const role = input.role
  return tools.filter((tool) => isSubagentToolAllowed(role, tool.name))
}

export function parseSubagentRequest(input: unknown): SubagentRequest | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  const role = record.role
  const task = record.task
  const successCriteria = record.success_criteria
  if (!isSubagentRole(role) || typeof task !== "string" || !task.trim()) return undefined
  return {
    role,
    task: task.trim(),
    ...(typeof successCriteria === "string" && successCriteria.trim() ? { successCriteria: successCriteria.trim() } : {}),
  }
}

export function formatSubagentResult(result: SubagentExecutionResult) {
  return JSON.stringify(result, null, 2)
}

export function budgetDeniedToolResult(role: SubagentRole, error: "subagent_budget_denied" | "subagent_concurrency_blocked" | "subagent_role_disabled", detail: string): ToolResult {
  return {
    title: "delegate_subagent",
    output: formatSubagentResult({ role, status: "failed", summary: detail }),
    metadata: { status: "failed", error, detail },
  }
}

export function blockedInternalActionToolResult(name: string, error: "subagent_nesting_blocked" | "subagent_internal_action_blocked", detail: string): ToolResult {
  return {
    title: name,
    output: detail,
    metadata: { status: "failed", error },
  }
}

export function createSubagentTaskState(packet: SubagentTaskPacket): SubagentTaskState {
  return {
    packet,
    turnsUsed: 0,
    findings: [],
    artifacts: [],
    blockedActions: [],
  }
}

export function noteSubagentTurn(state: SubagentTaskState, assistantText: string | undefined) {
  state.turnsUsed += 1
  if (assistantText && assistantText.trim()) {
    state.lastAssistantText = assistantText.trim()
    pushUnique(state.findings, compactText(assistantText, 240))
  }
}

export function noteSubagentToolResult(
  state: SubagentTaskState,
  input: { toolName: string; title: string; status: string; output: string },
) {
  pushUnique(state.artifacts, `${input.toolName}: ${input.title}`)
  if (input.status === "succeeded") {
    const preview = compactText(input.output, 200)
    if (preview) pushUnique(state.findings, `${input.toolName}: ${preview}`)
  }
}

export function noteSubagentBlockedAction(state: SubagentTaskState, toolName: string) {
  pushUnique(state.blockedActions, toolName)
}

export function buildSubagentHandoffResult(state: SubagentTaskState): SubagentExecutionResult {
  const remainingNeed = state.packet.successCriteria
    ? `Success criteria not yet proven: ${state.packet.successCriteria}.`
    : "The assigned task is not yet fully proven complete."
  const findings = state.findings.slice(0, 6)
  const artifacts = state.artifacts.slice(0, 6)
  const summaryParts = [
    `Subagent ${state.packet.role} reached its ${state.packet.maxProviderCalls}-turn budget and is returning a stage summary for the coordinator.`,
    state.lastAssistantText ? `Latest conclusion: ${state.lastAssistantText}` : "",
    findings.length > 0 ? `Collected ${findings.length} bounded findings.` : "",
    remainingNeed,
  ].filter(Boolean)
  const nextAction = findings.length > 0
    ? `If more evidence is needed, delegate a narrower follow-up task for ${state.packet.role} using the collected findings/artifacts.`
    : `Re-scope the task for ${state.packet.role} into a narrower follow-up with explicit files, symbols, or checks.`
  return {
    role: state.packet.role,
    status: "handoff",
    summary: summaryParts.join(" "),
    ...(findings.length > 0 ? { findings } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    nextAction,
  }
}

export function suggestedCoordinatorSubagentRole(toolCalls: ToolCall[]): Exclude<SubagentRole, "summary" | "reviewer" | "debugger" | "tester"> | undefined {
  if (toolCalls.length === 0) return undefined
  if (toolCalls.some((call) => call.name === "delegate_subagent")) return undefined
  const actionableCalls = toolCalls.filter((call) => !isCoordinatorOnlyTool(call.name))
  if (actionableCalls.length === 0) return undefined
  if (!actionableCalls.every((call) => delegatedCoordinatorToolNames.has(call.name))) return undefined
  if (actionableCalls.every((call) => docsResearchToolNames.has(call.name))) return "docs_researcher"
  if (actionableCalls.some((call) => delegatedSearchToolNames.has(call.name) || pureFactFindingToolNames.has(call.name))) return "explorer"
  return undefined
}

function pushUnique(list: string[], value: string) {
  if (!value.trim() || list.includes(value)) return
  list.push(value)
}

function compactText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`
}

function isSubagentRole(value: unknown): value is SubagentRole {
  return value === "summary" || value === "explorer" || value === "reviewer" || value === "debugger" || value === "tester" || value === "docs_researcher"
}
