import type { ToolDef } from "../tool"
import type { ToolResult } from "../tool/registry"
import type { SubagentRole } from "./types"

export type SubagentRequest = {
  role: SubagentRole
  task: string
  successCriteria?: string
}

export type SubagentExecutionResult = {
  role: SubagentRole
  status: "succeeded" | "failed"
  summary: string
  findings?: string[]
  artifacts?: string[]
  nextAction?: string
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
export const maxSubagentTurnsPerRun = 10

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
  "skill",
  "connector_list",
])
const activeDebugToolNames = new Set(["bash"])

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

function isSubagentRole(value: unknown): value is SubagentRole {
  return value === "summary" || value === "explorer" || value === "reviewer" || value === "debugger" || value === "tester" || value === "docs_researcher"
}
