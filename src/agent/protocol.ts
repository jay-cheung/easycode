import type { Agent, AgentKind } from "./types"
import { agentSystemPrompt } from "../prompt"


export function hasProposedPlanText(text: string): boolean {
  return /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(text)
}

export function stripPlanTags(text: string): string {
  return text.replace(/<\/?proposed_plan>/gi, "").trim()
}

export function createAgent(kind: AgentKind): Agent {
  if (kind === "summary") return { kind, name: "summary", mode: "plan", tools: "none", systemPrompt: agentSystemPrompt(kind) }
  if (kind === "plan") return { kind, name: "plan", mode: kind, tools: "enabled", systemPrompt: agentSystemPrompt(kind) }
  return { kind, name: "build", mode: kind, tools: "enabled", systemPrompt: agentSystemPrompt(kind) }
}
