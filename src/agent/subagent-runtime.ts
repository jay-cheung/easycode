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
  evidenceRefs?: string[]
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
  evidenceRefs: string[]
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
  summary: 3,
  explorer: 4,
  reviewer: 2,
  debugger: 3,
  tester: 3,
  docs_researcher: 2,
}

export const maxSubagentInvocationsPerRun = 10
export const maxSubagentTurnsPerRun = 32

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
const reviewTaskHintPattern = /\b(code review|review|reviewer|regression|audit)\b|代码评审|代码审查|复审|评审/i
const debugTaskHintPattern = /\b(debug|debugger|diagnos|trace|repro|crash|error|failure|flake|flaky|logs?)\b|调试|排查|复现|报错|错误|失败|日志/i
const verificationBashPattern = /^(bun test|bun run test|bun run build|bun run typecheck|bun run verify|bun run gate|npm test|npm run test|npm run build|npm run typecheck|npm run verify|pnpm test|pnpm run test|pnpm run build|pnpm run typecheck|pnpm run verify|pnpm exec tsc|npx tsc|go test|cargo test|pytest|vitest|jest|mocha)\b/i

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
    evidenceRefs: [],
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
    pushUnique(state.evidenceRefs, evidenceRef(input.toolName, input.title, input.output))
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
  const evidenceRefs = state.evidenceRefs.slice(0, 6)
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
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    nextAction,
  }
}

function evidenceRef(toolName: string, title: string, output: string) {
  const fileMatch = output.match(/\b(?:file|path):\s*([^\n]+)/i)
  const excerptMatch = output.match(/\bexcerpt:\s*([\s\S]{0,120})/i)
  const detail = fileMatch?.[1]?.trim() || excerptMatch?.[1]?.replace(/\s+/g, " ").trim() || compactText(output, 120)
  return compactText(`${toolName}: ${title}${detail ? ` (${detail})` : ""}`, 220)
}

export function suggestedCoordinatorSubagentRole(
  toolCalls: ToolCall[],
  hint: { taskHint?: string; requiredRole?: Exclude<SubagentRole, "summary"> } = {},
): Exclude<SubagentRole, "summary"> | undefined {
  if (toolCalls.length === 0) return undefined
  if (toolCalls.some((call) => call.name === "delegate_subagent")) return undefined
  const actionableCalls = toolCalls.filter((call) => !isCoordinatorOnlyTool(call.name))
  if (actionableCalls.length === 0) return undefined
  if (hint.requiredRole) return hint.requiredRole
  if (!actionableCalls.every((call) => delegatedCoordinatorToolNames.has(call.name) || call.name === "bash")) return undefined
  if (actionableCalls.every((call) => docsResearchToolNames.has(call.name))) return "docs_researcher"
  if (looksLikeTesterTurn(actionableCalls)) return "tester"
  if (looksLikeDebuggerTurn(actionableCalls, hint.taskHint)) return "debugger"
  if (looksLikeReviewerTurn(actionableCalls, hint.taskHint)) return "reviewer"
  if (actionableCalls.some((call) => delegatedSearchToolNames.has(call.name) || pureFactFindingToolNames.has(call.name))) return "explorer"
  return undefined
}

function looksLikeReviewerTurn(actionableCalls: ToolCall[], taskHint?: string) {
  if (!taskHint || !reviewTaskHintPattern.test(taskHint)) return false
  return actionableCalls.every((call) => pureFactFindingToolNames.has(call.name))
}

function looksLikeDebuggerTurn(actionableCalls: ToolCall[], taskHint?: string) {
  if (!actionableCalls.some((call) => call.name === "bash")) return false
  if (looksLikeTesterTurn(actionableCalls)) return false
  return debugTaskHintPattern.test(taskHint ?? "")
}

function looksLikeTesterTurn(actionableCalls: ToolCall[]) {
  const bashCalls = actionableCalls.filter((call) => call.name === "bash")
  if (bashCalls.length === 0) return false
  return bashCalls.every((call) => verificationBashPattern.test(bashCommand(call)))
}

function bashCommand(call: ToolCall) {
  if (!call.input || typeof call.input !== "object") return ""
  const command = (call.input as Record<string, unknown>).command
  return typeof command === "string" ? command.trim() : ""
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
