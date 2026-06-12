import type { Agent, AgentKind } from "./types"
import { agentSystemPrompt } from "../prompt"


export function hasProposedPlanText(text: string): boolean {
  return /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(text)
}

export function stripPlanTags(text: string): string {
  return text.replace(/<\/?proposed_plan>/gi, "").trim()
}

export function createAgent(kind: AgentKind): Agent {
  if (kind === "summary") return { kind, name: "summary", role: "summary", depth: 1, mode: "plan", tools: "none", systemPrompt: agentSystemPrompt(kind) }
  if (kind === "explorer" || kind === "reviewer" || kind === "debugger" || kind === "tester" || kind === "docs_researcher") {
    return { kind, name: kind, role: kind, depth: 1, mode: "build", tools: "enabled", systemPrompt: agentSystemPrompt(kind) }
  }
  return { kind, name: "run", depth: 0, mode: "build", tools: "enabled", systemPrompt: agentSystemPrompt(kind) }
}
