import type { ContextManagerLike, LedgerRecord } from "../../context"
import type { ToolRegistryLike, ToolResult } from "../../tool"
import type { ToolCall, AgentMode } from "../../message"
import type { PermissionService } from "../../permission"
import type { SkillServiceLike } from "../../skill"
import type { Sandbox } from "../../sandbox"
import type { RunUiEvent } from "../../ui/timeline"
import { ledgerRecord, toolScopeFiles } from "../ledger"
import { recordCapabilityUsageState } from "./hypothesis-state"

type ToolExecutionDeps = {
  registry: ToolRegistryLike
  sandbox: Sandbox
  permission: PermissionService
  permissionFor: (mode: AgentMode) => PermissionService
  skills: SkillServiceLike
  context: ContextManagerLike
  onEvent?: (event: RunUiEvent) => void
  toolProgressIntervalMs: number
}

export async function runToolCall(
  deps: ToolExecutionDeps,
  call: ToolCall,
  mode: AgentMode,
  signal?: AbortSignal,
): Promise<ToolResult> {
  let progressTimer: ReturnType<typeof setInterval> | undefined
  try {
    return await deps.registry.run(call.name, call.input, {
      agentMode: mode,
      sandbox: deps.sandbox,
      permission: deps.permissionFor(mode),
      skills: deps.skills,
      messages: deps.context.state.messages,
      context: deps.context,
      signal,
      onExecuteStart: () => {
        progressTimer = startToolProgressTimer(deps, call, Date.now())
      },
    })
  } catch (error) {
    return { title: call.name, output: error instanceof Error ? error.message : String(error), metadata: { status: "failed", error: error instanceof Error ? error.name : "UnknownError" } }
  } finally {
    if (progressTimer) clearInterval(progressTimer)
  }
}

export function emitToolResultEvent(
  deps: Pick<ToolExecutionDeps, "onEvent">,
  call: ToolCall,
  result: ToolResult,
) {
  deps.onEvent?.({
    type: "tool_result",
    callID: call.id,
    toolName: call.name,
    title: result.title,
    status: String(result.metadata.status ?? "failed"),
    output: result.output,
    durationMs: numericMetadata(result.metadata.durationMs),
  })
}

export function recordToolOutcome(
  deps: Pick<ToolExecutionDeps, "context">,
  call: ToolCall,
  result: ToolResult,
  prompt: string,
  helpers: {
    truncateForLedger: (text: string, maxLength: number) => string
    compactLine: (text: string) => string
  },
) {
  const turn = deps.context.state.messages.length
  if (result.metadata.status === "succeeded") {
    const files = toolScopeFiles(call, result)
    const toolEvidence = { source: "tool" as const }
    const current: LedgerRecord[] = [
      ledgerRecord("failure", "last_tool_failure", `resolved by ${call.name}`, "resolved", turn, { reason: "a later tool call succeeded", evidence: toolEvidence }),
    ]
    if (files.length) {
      current.push(ledgerRecord("file", files.join(","), `${call.name} succeeded: ${helpers.truncateForLedger(result.title, 160)}`, "current", turn, { evidence: toolEvidence, scope: { files } }))
    } else {
      current.push(ledgerRecord("checkpoint", "last_successful_tool", `${call.name} ${helpers.truncateForLedger(result.title, 120)}`, "current", turn, { evidence: toolEvidence }))
    }
    deps.context.updateLedger({ current })
    recordToolCapabilityUsage(deps.context, call, result)
    return
  }

  const summary = toolFailureSummary(call, result, helpers.truncateForLedger)
  const recovery = recoveryHintForToolFailure(call, result)
  const failureEvidence = { source: "tool" as const }
  const scopedFiles = toolScopeFiles(call, result)
  deps.context.updateLedger({
    current: [
      ledgerRecord("failure", "last_tool_failure", summary, "current", turn, { evidence: failureEvidence, scope: scopedFiles.length ? { files: scopedFiles } : undefined }),
      ledgerRecord("constraint", "tool_failure_scope_rule", "tool failure requires recovery, not abandoning or silently shrinking scope.", "current", turn),
      ledgerRecord("intent", "main_objective_still_active", helpers.truncateForLedger(helpers.compactLine(prompt), 200), "current", turn, { evidence: { source: "user" } }),
      ledgerRecord("constraint", "next_recovery_action", recovery, "current", turn),
    ],
  })
}

function recordToolCapabilityUsage(
  context: ContextManagerLike,
  call: ToolCall,
  result: ToolResult,
) {
  if (call.name === "mcp_list_resources") {
    recordCapabilityUsageState(context, { mcpServers: mcpServersFromSources(result.metadata.sources) })
    return
  }
  if (call.name === "mcp_read_resource") {
    const server = stringInputField(call.input, "server") ?? mcpServerFromSource(result.metadata.source)
    const uri = stringInputField(call.input, "uri")
    recordCapabilityUsageState(context, {
      mcpServers: server ? [server] : [],
      mcpResources: uri ? [uri] : [],
    })
    return
  }
  if (call.name === "connector_call") {
    const connector = typeof result.metadata.connector === "string" ? result.metadata.connector : stringInputField(call.input, "name")
    recordCapabilityUsageState(context, { connectors: connector ? [connector] : [] })
    return
  }
  if (call.name === "web_search") {
    const engine = typeof result.metadata.engine === "string" ? result.metadata.engine : undefined
    recordCapabilityUsageState(context, { webSearchEngines: engine ? [engine] : [] })
  }
}

function stringInputField(input: unknown, field: string) {
  if (!input || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function mcpServersFromSources(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const server = mcpServerFromSource(item)
    return server ? [server] : []
  }))].sort((left, right) => left.localeCompare(right))
}

function mcpServerFromSource(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const id = (value as { id?: unknown }).id
  if (typeof id !== "string") return undefined
  const delimiter = id.indexOf(":")
  return delimiter > 0 ? id.slice(0, delimiter) : undefined
}

function startToolProgressTimer(
  deps: Pick<ToolExecutionDeps, "onEvent" | "toolProgressIntervalMs">,
  call: ToolCall,
  startedAt: number,
) {
  if (!deps.onEvent || call.name !== "bash" || deps.toolProgressIntervalMs <= 0) return undefined
  return setInterval(() => {
    deps.onEvent?.({ type: "tool_progress", callID: call.id, toolName: call.name, elapsedMs: Date.now() - startedAt })
  }, deps.toolProgressIntervalMs)
}

function numericMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toolFailureSummary(
  call: ToolCall,
  result: { title: string; output: string; metadata: Record<string, unknown> },
  truncateForLedger: (text: string, maxLength: number) => string,
) {
  const status = String(result.metadata.status ?? "failed")
  const error = typeof result.metadata.error === "string" ? ` ${result.metadata.error}` : ""
  const output = compactLine(result.output)
  return `${call.name} ${status}${error}: ${truncateForLedger(output || result.title, 220)}`
}

function recoveryHintForToolFailure(call: ToolCall, result: { output: string; metadata: Record<string, unknown> }) {
  const output = `${result.output}\n${JSON.stringify(result.metadata)}\n${JSON.stringify(call.input)}`
  if (call.name === "bash" && /SandboxPathEscapeError|path_boundary_escape|path_boundary_blocked|Path escapes project root|Operation not permitted|native_write_sandbox_denial|native_write_sandbox_blocked/i.test(output)) {
    return "next_recovery_action: keep command goal; use project-local paths or allowed scratch paths like /tmp and /dev/null; do not request sandbox_bypass."
  }
  if (call.name === "bash" && /JSON\.parse|Unexpected token|SyntaxError/i.test(output)) {
    return "next_recovery_action: keep requested scope; separate runner noise from machine JSON; parse project-local report or direct script output."
  }
  if (call.name === "bash" && /timed out|timeout/i.test(output)) {
    return "next_recovery_action: keep requested scope; use longer timeout or label any subset as diagnostic before full rerun."
  }
  return "next_recovery_action: inspect failure, preserve requested scope, choose smallest safe recovery."
}

function compactLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}
