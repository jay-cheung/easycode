import type { Agent } from "../agent"
import { createMessage, messagesToProviderInput, redactProtectedMessages, summaryPart, textMessage, validProviderMessageSuffix, type Message, type ProviderInputMessage } from "../message"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"

export type ContextState = {
  messages: Message[]
  summary?: string
  tokenEstimate: number
  maxTokens: number
}

export type ContextOptions = {
  maxTokens?: number
  compactAt?: number
  preserveRecentMessages?: number
}

export interface ContextManagerLike {
  readonly state: ContextState
  readonly compactAt: number
  readonly preserveRecentMessages: number
  add(message: Message): void
  estimate(messages: Message[]): number
  needsCompaction(): boolean
  compactionInput(): ProviderInputMessage[]
  compact(summary: string): boolean
  compose(input?: { agent: Agent; skills: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[]
}

export class ContextManager implements ContextManagerLike {
  readonly state: ContextState
  readonly compactAt: number
  readonly preserveRecentMessages: number

  constructor(options: ContextOptions = {}) {
    this.compactAt = options.compactAt ?? 0.75
    this.preserveRecentMessages = options.preserveRecentMessages ?? 4
    this.state = { messages: [], tokenEstimate: 0, maxTokens: options.maxTokens ?? 6_000 }
  }

  add(message: Message) {
    this.state.messages.push(message)
    this.state.tokenEstimate = this.estimate(this.state.messages)
  }

  estimate(messages: Message[]) {
    return Math.ceil(messagesToProviderInput(messages).map((message) => message.content).join("\n").length / 4)
  }

  needsCompaction() {
    return this.state.tokenEstimate > this.state.maxTokens * this.compactAt
  }

  compactionInput() {
    if (!this.needsCompaction()) return []
    const compacted = this.state.messages.slice(0, Math.max(0, this.state.messages.length - this.preserveRecentMessages))
    const messages: Message[] = []
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(`Previous summary:\n${this.state.summary}`)]))
    messages.push(...redactProtectedMessages(compacted))
    return messagesToProviderInput(messages, { redactProtectedToolResults: true })
  }

  compact(summary: string) {
    if (!this.needsCompaction()) return false
    const preserved = validProviderMessageSuffix(this.state.messages.slice(-this.preserveRecentMessages))
    this.state.summary = summary
    this.state.messages = preserved
    this.state.tokenEstimate = this.estimate(this.state.messages) + Math.ceil(this.state.summary.length * 2)
    return true
  }

  compose(input?: { agent: Agent; skills: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[] {
    const messages: Message[] = []
    if (input) {
      const skillList = input.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") || "(none)"
      const toolList = input.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
      const system = [input.agent.systemPrompt, `Mode: ${input.agent.mode}`, `Available skills, descriptions only until skill tool is called:\n${skillList}`, `Available tools:\n${toolList}`].join("\n\n")
      messages.push(textMessage("system", system))
    }
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(this.state.summary)]))
    messages.push(...this.state.messages)
    return messagesToProviderInput(messages)
  }
}
