import type { ToolCall } from "../message"
import type { ToolDef } from "../tool"
import type { ToolResult } from "../tool/registry"
import { stableStringify } from "../context/ledger"
import type { SubagentRole } from "./types"

export type SubagentRequest = {
  role: SubagentRole
  task: string
  successCriteria?: string
}

export type SubagentExecutionStatus = "succeeded" | "handoff" | "failed"
export type SubagentBlockerClass =
  | "permission_denied"
  | "tool_unavailable"
  | "invalid_tool_use"
  | "large_output_or_read_blocked"
  | "network_or_provider"
  | "insufficient_evidence"
  | "none"

export type SubagentExecutionResult = {
  role: SubagentRole
  status: SubagentExecutionStatus
  summary: string
  findings?: string[]
  evidenceRefs?: string[]
  artifacts?: string[]
  nextAction?: string
  blockerClass?: SubagentBlockerClass
  retryable?: boolean
  recommendedNextRole?: Exclude<SubagentRole, "summary">
  recommendedNextTool?: string
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
  toolFailures: SubagentToolFailure[]
}

export type SubagentToolFailure = {
  fingerprint: string
  toolName: string
  title: string
  status: string
  error?: string
  blockerClass: SubagentBlockerClass
  retryable: boolean
  outputPreview: string
  recommendedNextRole?: Exclude<SubagentRole, "summary">
  recommendedNextTool?: string
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
const docsTaskHintPattern = /\b(web_fetch|web_search|https?:\/\/|api\b|http\b|public data|external docs?|external spec|documentation|mcp|connector|fetch data|market data|stock data)\b|外部|公开\s*api|数据源|接口|文档|资料|网页|抓取|行情/i
const verificationBashPattern = /^(bun test|bun run test|bun run build|bun run typecheck|bun run verify|bun run gate|npm test|npm run test|npm run build|npm run typecheck|npm run verify|pnpm test|pnpm run test|pnpm run build|pnpm run typecheck|pnpm run verify|pnpm exec tsc|npx tsc|go test|cargo test|pytest|vitest|jest|mocha)\b/i
const deterministicBlockers = new Set<SubagentBlockerClass>(["permission_denied", "tool_unavailable", "invalid_tool_use", "large_output_or_read_blocked"])

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
    toolFailures: [],
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
  input: { toolName: string; title: string; status: string; output: string; metadata?: Record<string, unknown>; call?: ToolCall },
) {
  pushUnique(state.artifacts, `${input.toolName}: ${input.title}`)
  if (input.status === "succeeded") {
    const preview = compactText(input.output, 200)
    if (preview) pushUnique(state.findings, `${input.toolName}: ${preview}`)
    pushUnique(state.evidenceRefs, evidenceRef(input.toolName, input.title, input.output))
    return
  }
  const failure = classifySubagentToolFailure(input)
  if (!failure) return
  state.toolFailures.push({
    ...failure,
    fingerprint: input.call ? toolFailureFingerprint(input.call, input) : `${input.toolName}:${failure.blockerClass}:${compactText(input.output, 120)}`,
  })
  pushUnique(state.findings, `${failure.blockerClass}: ${failure.outputPreview}`)
  pushUnique(state.evidenceRefs, evidenceRef(input.toolName, input.title, input.output))
}

export function classifySubagentToolFailure(input: {
  toolName: string
  title: string
  status: string
  output: string
  metadata?: Record<string, unknown>
  call?: ToolCall
}): Omit<SubagentToolFailure, "fingerprint"> | undefined {
  if (input.status === "succeeded") return undefined
  const error = typeof input.metadata?.error === "string" ? input.metadata.error : undefined
  const callInput = input.call ? stableStringify(normalizeToolFailureInput(input.call.name, input.call.input)) : ""
  const text = `${input.title}\n${input.output}\n${error ?? ""}\n${callInput}`.toLowerCase()
  const blockerClass = blockerClassForFailure(input.status, error, text)
  const retryable = blockerClass === "network_or_provider"
  const recommendation = recommendationForFailure(input.toolName, blockerClass, text)
  return {
    toolName: input.toolName,
    title: input.title,
    status: input.status,
    ...(error ? { error } : {}),
    blockerClass,
    retryable,
    outputPreview: compactText(input.output || error || input.title, 220),
    ...recommendation,
  }
}

export function noteSubagentBlockedAction(state: SubagentTaskState, toolName: string) {
  pushUnique(state.blockedActions, toolName)
}

export function buildSubagentHandoffResult(state: SubagentTaskState): SubagentExecutionResult {
  const topFailure = latestSignificantFailure(state)
  const remainingNeed = state.packet.successCriteria
    ? `Success criteria not yet proven: ${state.packet.successCriteria}.`
    : "The assigned task is not yet fully proven complete."
  const findings = state.findings.slice(0, 6)
  const evidenceRefs = state.evidenceRefs.slice(0, 6)
  const artifacts = state.artifacts.slice(0, 6)
  const summaryParts = [
    topFailure
      ? `Subagent ${state.packet.role} hit blocker ${topFailure.blockerClass} on ${topFailure.toolName} and is returning a handoff for the coordinator.`
      : `Subagent ${state.packet.role} reached its ${state.packet.maxProviderCalls}-turn budget and is returning a stage summary for the coordinator.`,
    state.lastAssistantText ? `Latest conclusion: ${state.lastAssistantText}` : "",
    findings.length > 0 ? `Collected ${findings.length} bounded findings.` : "",
    remainingNeed,
  ].filter(Boolean)
  const nextAction = topFailure
    ? nextActionForFailure(topFailure)
    : findings.length > 0
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
    blockerClass: topFailure?.blockerClass ?? (findings.length > 0 ? "insufficient_evidence" : "none"),
    retryable: topFailure?.retryable ?? true,
    ...(topFailure?.recommendedNextRole ? { recommendedNextRole: topFailure.recommendedNextRole } : {}),
    ...(topFailure?.recommendedNextTool ? { recommendedNextTool: topFailure.recommendedNextTool } : {}),
  }
}

export function toolFailureFingerprint(call: ToolCall, result: { status: string; metadata?: Record<string, unknown>; output: string }) {
  const error = typeof result.metadata?.error === "string" ? result.metadata.error : ""
  return stableStringify({
    tool: call.name,
    input: normalizeToolFailureInput(call.name, call.input),
    status: result.status,
    error,
  })
}

export function shouldStopSubagentAfterFailure(state: SubagentTaskState) {
  const latest = state.toolFailures.at(-1)
  if (!latest) return undefined
  const sameFingerprintCount = state.toolFailures.filter((failure) => failure.fingerprint === latest.fingerprint).length
  if (sameFingerprintCount >= 2) return latest
  if (deterministicBlockers.has(latest.blockerClass)) {
    const sameBlockerCount = state.toolFailures.filter((failure) => failure.blockerClass === latest.blockerClass).length
    if (sameBlockerCount >= 2) return latest
  }
  if (latest.blockerClass === "network_or_provider") {
    const sameBlockerCount = state.toolFailures.filter((failure) => failure.blockerClass === latest.blockerClass).length
    if (sameBlockerCount >= 2) return latest
  }
  return undefined
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
  if (looksLikeDocsResearchTurn(actionableCalls, hint.taskHint)) return "docs_researcher"
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
  if (looksLikeDocsResearchTurn(actionableCalls, taskHint)) return false
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

function looksLikeDocsResearchTurn(actionableCalls: ToolCall[], taskHint?: string) {
  if (actionableCalls.some((call) => docsResearchToolNames.has(call.name))) return true
  if (docsTaskHintPattern.test(taskHint ?? "")) return true
  return actionableCalls.some((call) => call.name === "bash" && looksLikeHttpFetchCommand(bashCommand(call)))
}

function looksLikeHttpFetchCommand(command: string) {
  return /\b(curl|wget|httpie|python\s+-c|node\s+-e)\b/.test(command) && /https?:\/\//.test(command)
}

function blockerClassForFailure(status: string, error: string | undefined, text: string): SubagentBlockerClass {
  if (status === "denied" || /permission rejected|permission denied|not allowed|denied/.test(text)) return "permission_denied"
  if (/large_file_read_forbidden|full-file read blocked|exceeds \d+ lines|large output/.test(text)) return "large_output_or_read_blocked"
  if (/duplicate_inspection|invalid_tool_arguments|invalid arguments|subagent_nesting_blocked|subagent_internal_action_blocked|coordinator-only|cannot create or delegate/.test(text)) return "invalid_tool_use"
  if (/tool not found|tool disabled|not available|internal_action_not_intercepted/.test(text)) return "tool_unavailable"
  if (/\b(econnrefused|econnreset|enotfound|eai_again|etimedout|timeout|timed out|connection refused|connection reset|network request failed|fetch failed|socket hang up|tls|ssl|quota|rate limit|provider_error)\b/.test(text)) return "network_or_provider"
  return error ? "invalid_tool_use" : "insufficient_evidence"
}

function recommendationForFailure(toolName: string, blockerClass: SubagentBlockerClass, text: string): Pick<SubagentToolFailure, "recommendedNextRole" | "recommendedNextTool"> {
  if (blockerClass === "large_output_or_read_blocked" && toolName === "read") return { recommendedNextRole: "explorer", recommendedNextTool: "read_lines" }
  if (toolName === "bash" && /https?:\/\//.test(text)) return { recommendedNextRole: "docs_researcher", recommendedNextTool: "web_fetch" }
  if (blockerClass === "tool_unavailable" && /mcp|connector|web|http|api/.test(text)) return { recommendedNextRole: "docs_researcher" }
  return {}
}

function latestSignificantFailure(state: SubagentTaskState) {
  return [...state.toolFailures].reverse().find((failure) => failure.blockerClass !== "insufficient_evidence") ?? state.toolFailures.at(-1)
}

function nextActionForFailure(failure: SubagentToolFailure) {
  const parts = [`Stop retrying ${failure.toolName}; ${failure.blockerClass} is blocking this path.`]
  if (failure.recommendedNextRole) parts.push(`Recommended next role: ${failure.recommendedNextRole}.`)
  if (failure.recommendedNextTool) parts.push(`Recommended next tool: ${failure.recommendedNextTool}.`)
  if (!failure.retryable) parts.push("Do not retry the same tool/input without new permission or evidence.")
  return parts.join(" ")
}

function normalizeToolFailureInput(toolName: string, input: unknown): unknown {
  if (!input || typeof input !== "object") return input
  if (toolName === "bash") {
    const command = (input as { command?: unknown }).command
    return { command: typeof command === "string" ? command.replace(/\s+/g, " ").trim() : command }
  }
  return input
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
