import type { Agent } from "./agent"
import { createMessage, messagesToProviderInput, summaryPart, textMessage, type Message, type ProviderInputMessage } from "./message"
import type { SkillInfo } from "./skill"
import type { ToolDef } from "./tool"

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
  compact(): boolean
  compose(input: { agent: Agent; skills: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[]
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

  compact() {
    if (!this.needsCompaction()) return false
    const preserved = this.state.messages.slice(-this.preserveRecentMessages)
    const compacted = this.state.messages.slice(0, Math.max(0, this.state.messages.length - this.preserveRecentMessages))
    const previous = this.state.summary ? [`Previous summary:\n${this.state.summary}`] : []
    const facts = compacted.flatMap((message) => messagesToProviderInput([message]).map((item) => `${item.role}: ${item.content}`)).join("\n").slice(-4_000)
    this.state.summary = [...previous, facts].filter(Boolean).join("\n\n")
    this.state.messages = preserved
    this.state.tokenEstimate = this.estimate(this.state.messages) + Math.ceil(this.state.summary.length / 4)
    return true
  }

  compose(input: { agent: Agent; skills: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[] {
    const skillList = input.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") || "(none)"
    const toolList = input.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
    const system = [input.agent.systemPrompt, `Mode: ${input.agent.mode}`, `Available skills, descriptions only until skill tool is called:\n${skillList}`, `Available tools:\n${toolList}`].join("\n\n")
    const messages = [textMessage("system", system)]
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(this.state.summary)]))
    messages.push(...this.state.messages)
    return messagesToProviderInput(messages)
  }
}
