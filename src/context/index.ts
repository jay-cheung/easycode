import type { Agent } from "../agent"
import { createMessage, messagesToProviderInput, redactProtectedMessages, summaryPart, textMessage, validProviderMessageSuffix, type Message, type ProviderInputMessage } from "../message"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"

export type ContextState = {
  messages: Message[]
  summary?: string
  tokenEstimate: number
  maxTokens: number
  latestActualInputTokens?: number
}

export type ContextOptions = {
  maxTokens?: number
  compactAt?: number
  preserveRecentUserTurns?: number
  compactPreserveTokens?: number
}

export interface ContextManagerLike {
  readonly state: ContextState
  readonly compactAt: number
  readonly preserveRecentUserTurns: number
  readonly compactPreserveTokens: number
  add(message: Message): void
  estimate(messages: Message[]): number
  recordUsage(inputTokens: number): void
  needsCompaction(): boolean
  compactionInput(): ProviderInputMessage[]
  compact(summary: string): boolean
  compose(input?: { agent: Agent; skills: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[]
}

export class ContextManager implements ContextManagerLike {
  readonly state: ContextState
  readonly compactAt: number
  readonly preserveRecentUserTurns: number
  readonly compactPreserveTokens: number

  constructor(options: ContextOptions = {}) {
    this.compactAt = options.compactAt ?? 0.75
    this.preserveRecentUserTurns = options.preserveRecentUserTurns ?? 2
    this.compactPreserveTokens = options.compactPreserveTokens ?? 1_000
    this.state = { messages: [], tokenEstimate: 0, maxTokens: options.maxTokens ?? 20_000 }
  }

  add(message: Message) {
    this.state.messages.push(message)
    this.recalculateTokenEstimate()
  }

  estimate(messages: Message[]) {
    return estimateTextTokens(messagesToProviderInput(messages).map((message) => message.content).join("\n"))
  }

  recordUsage(inputTokens: number) {
    this.state.latestActualInputTokens = inputTokens
  }

  needsCompaction() {
    return this.state.tokenEstimate > this.state.maxTokens * this.compactAt
  }

  compactionInput() {
    if (!this.needsCompaction()) return []
    const { compacted } = splitRecentUserTurns(this.state.messages, this.preserveRecentUserTurns)
    const messages: Message[] = []
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(`Previous summary:\n${this.state.summary}`)]))
    messages.push(...redactProtectedMessages(compacted))
    return messagesToProviderInput(messages, { redactProtectedToolResults: true })
  }

  compact(summary: string) {
    if (!this.needsCompaction()) return false
    const { recent } = splitRecentUserTurns(this.state.messages, this.preserveRecentUserTurns)
    const preserved = recentProviderMessageSuffix(recent, this.compactPreserveTokens)
    this.state.summary = summary
    this.state.messages = preserved
    this.recalculateTokenEstimate()
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

  private recalculateTokenEstimate() {
    this.state.tokenEstimate = this.estimate(this.state.messages) + estimateSummaryTokens(this.state.summary)
  }
}

export function estimateTextTokens(text: string) {
  let tokens = 0
  for (const char of text) tokens += isCJK(char) ? 0.6 : 0.3
  return Math.ceil(tokens)
}

export function estimateSummaryTokens(summary: string | undefined) {
  if (!summary) return 0
  return estimateTextTokens(messageToSummaryText(summary))
}

export function recentUserTurnMessages(messages: Message[], preserveRecentUserTurns = 2) {
  return validProviderMessageSuffix(splitRecentUserTurns(messages, preserveRecentUserTurns).recent)
}

export function recentProviderMessageSuffix(messages: Message[], maxTokens = 1_000) {
  const suffix: Message[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = validProviderMessageSuffix([messages[index], ...suffix])
    if (candidate.length === 0) continue
    if (estimateMessages(candidate) > maxTokens && suffix.length > 0) break
    suffix.unshift(messages[index])
  }
  return validProviderMessageSuffix(suffix)
}

function splitRecentUserTurns(messages: Message[], preserveRecentUserTurns: number) {
  if (preserveRecentUserTurns <= 0) return { compacted: messages, recent: [] }
  let userTurns = 0
  let start = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue
    userTurns += 1
    start = index
    if (userTurns >= preserveRecentUserTurns) break
  }
  if (userTurns === 0) return { compacted: [], recent: validProviderMessageSuffix(messages) }
  return { compacted: messages.slice(0, start), recent: messages.slice(start) }
}

function messageToSummaryText(summary: string) {
  return `<summary>\n${summary}\n</summary>`
}

function isCJK(char: string) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char)
}

function estimateMessages(messages: Message[]) {
  return estimateTextTokens(messagesToProviderInput(messages).map((message) => message.content).join("\n"))
}
