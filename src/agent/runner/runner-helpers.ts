import { buildCompactPrompt } from "../../context/prompt"
import { createMessage, reasoningPart, textPart, type MessagePart } from "../../message"
import type { ContextManagerLike } from "../../context"

export function explorationSummaryStep(maxSteps: number) {
  const defaultExplorationSteps = 12
  return Math.min(defaultExplorationSteps, Math.ceil(maxSteps * 0.7))
}

export function explorationSummaryReadinessMessage(step: number, maxSteps: number) {
  return {
    role: "user" as const,
    content: [
      `Exploration checkpoint reached at step ${step}/${maxSteps}.`,
      "Before calling another tool, decide whether the information already gathered is enough to answer the user's request.",
      "If it is enough, stop exploring and provide the summary now.",
      "If it is not enough, do not call tools. Ask the user whether to continue exploring or summarize with the current evidence.",
    ].join("\n"),
  }
}

const contextHeavyTools = new Set([
  "read",
  "read_lines",
  "grep",
  "rg_search",
  "find_definition",
  "find_references",
  "call_graph",
  "repo_map",
  "list",
  "git_diff",
  "git_status",
  "git_branch",
  "git_log",
  "ledger",
  "memory_query",
  "delegate_subagent",
])

const maxContextHeavyToolCalls = 32
const maxGitDiffCalls = 8
const maxReadLineCalls = 36
const maxDelegateSubagentCalls = 4

export function contextBudgetReadinessMessage(input: { usedTools: string[]; activePlanStepId?: string }) {
  const counts = toolCounts(input.usedTools)
  const contextHeavyCount = input.usedTools.filter((tool) => contextHeavyTools.has(tool)).length
  const reasons = [
    contextHeavyCount >= maxContextHeavyToolCalls ? `${contextHeavyCount} context-heavy tool calls` : "",
    (counts.get("git_diff") ?? 0) >= maxGitDiffCalls ? `${counts.get("git_diff")} git_diff calls` : "",
    (counts.get("read_lines") ?? 0) >= maxReadLineCalls ? `${counts.get("read_lines")} read_lines calls` : "",
    (counts.get("delegate_subagent") ?? 0) >= maxDelegateSubagentCalls ? `${counts.get("delegate_subagent")} delegate_subagent calls` : "",
  ].filter(Boolean)
  if (reasons.length === 0) return undefined
  return {
    role: "user" as const,
    content: [
      `Context budget checkpoint reached: ${reasons.join(", ")}.`,
      "Do not call more tools in this turn.",
      input.activePlanStepId
        ? "Use the evidence already gathered to call plan_step_complete with a concise report, call plan_step_fail with the blocker, or provide the current review summary if the step cannot be completed."
        : "Use the evidence already gathered to provide the current summary or ask whether to continue exploring.",
      "Avoid re-reading diffs or large tool outputs unless the user explicitly asks to continue.",
    ].join("\n"),
  }
}

function toolCounts(tools: string[]) {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return counts
}

export function appendOutput(output: string, part: string) {
  if (!part) return output
  if (!output || output.endsWith("\n")) return `${output}${part}`
  return `${output}\n${part}`
}

export function assistantMessage(reasoningText: string, text: string) {
  const parts: MessagePart[] = []
  if (reasoningText) parts.push(reasoningPart(reasoningText))
  if (text) parts.push(textPart(text))
  return createMessage("assistant", parts.length > 0 ? parts : [textPart("")])
}

export function compactPrompt(messages: Array<{ role: string; content: string }>, options?: Parameters<typeof buildCompactPrompt>[1]) {
  const transcript = messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")
  return buildCompactPrompt(transcript, options)
}

export function summaryLanguageHint(context: ContextManagerLike, messages: Array<{ role: string; content: string }>) {
  const currentRequest = ledgerValue(context, "current_user_request")
  return detectLanguageHint(currentRequest) ?? detectLanguageHint([...messages].reverse().find((message) => message.role === "user" && message.content.trim())?.content)
}

export function ledgerValue(context: ContextManagerLike, subject: string) {
  return context.state.ledger?.current?.find((record) => record.subject === subject)?.value
}

export function detectLanguageHint(text: string | undefined) {
  if (!text) return undefined
  if (/[\u3040-\u30ff]/u.test(text)) return "Japanese"
  if (/[\uac00-\ud7af]/u.test(text)) return "Korean"
  if (/[\u4e00-\u9fff]/u.test(text)) return "Chinese"
  return undefined
}
