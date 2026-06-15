import type { ToolCall } from "../message"
import type { Agent, AgentKind } from "./types"
import { agentSystemPrompt } from "../prompt"


export function hasProposedPlanText(text: string): boolean {
  return /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(text)
}

export function stripPlanTags(text: string): string {
  return text.replace(/<\/?proposed_plan>/gi, "").trim()
}

export function isProposalPlanTurn(input: { text: string; toolCalls: Pick<ToolCall, "name">[] }): boolean {
  return input.toolCalls.some((call) => call.name === "plan_exit") || hasProposedPlanText(input.text)
}

export const hardPlanGateCorrection = [
  "Planning mode hard gate:",
  "- Your next assistant turn must return a proposal plan.",
  "- Return either a final <proposed_plan>...</proposed_plan> block or call plan_exit.",
  "- Do not return status chat, execution updates, or any non-plan final message.",
  "- Read-only planning tools are allowed before the final plan; if you already inspected the code, fold those findings into the proposal plan itself.",
].join("\n")

export const hardPlanGateFailureText = "Planning mode hard gate failed: the model must return a <proposed_plan>...</proposed_plan> response or call plan_exit."

export function createAgent(kind: AgentKind): Agent {
  if (kind === "summary") return { kind, name: "summary", role: "summary", depth: 1, mode: "plan", tools: "none", systemPrompt: agentSystemPrompt(kind) }
  if (kind === "explorer" || kind === "reviewer" || kind === "debugger" || kind === "tester" || kind === "docs_researcher") {
    return { kind, name: kind, role: kind, depth: 1, mode: "build", tools: "enabled", systemPrompt: agentSystemPrompt(kind) }
  }
  return { kind, name: "run", depth: 0, mode: "build", tools: "enabled", systemPrompt: agentSystemPrompt(kind) }
}
