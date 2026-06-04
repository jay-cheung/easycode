import type { ContextManagerLike, LedgerRecord } from "../context"
import type { ToolRegistryLike, ToolResult } from "../tool"
import type { ToolCall, AgentMode } from "../message"
import type { PermissionService } from "../permission"
import type { SkillServiceLike } from "../skill"
import type { Sandbox } from "../sandbox"
import type { RunUiEvent } from "../ui/timeline"
import { ledgerRecord, toolScopeFiles } from "./ledger"

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
  if (call.name === "bash" && /SandboxPathEscapeError|path_boundary_escape|Path escapes project root|\/tmp|\/dev\/null|Operation not permitted|native_write_sandbox_denial/i.test(output)) {
    return "next_recovery_action: keep command goal; use project-local paths like .easycode/tmp or .easycode/reports; avoid /tmp and /dev/null; request bypass only with user approval."
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
