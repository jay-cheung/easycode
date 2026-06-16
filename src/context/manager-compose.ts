import type { Agent } from "../agent"
import type { InstructionInfo } from "../instruction"
import {
  createMessage,
  messagesToProviderInput,
  redactProtectedMessages,
  summaryPart,
  textMessage,
  validProviderMessageSuffix,
  type Message,
  type ProviderInputMessage,
} from "../message"
import { buildContextSystemPrompt, buildInstructionPrompt, buildSkillPrompt } from "../prompt"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"
import { renderContextLedger } from "./ledger"
import { splitRecentUserTurns } from "./tokens"
import type { ContextCompactionSnapshot, ContextLedger } from "./types"

export function buildCompactionSnapshot(input: {
  messages: Message[]
  preserveRecentUserTurns: number
  ledger: ContextLedger | undefined
  summary: string | undefined
  toolResultTokenBudget?: number
}): ContextCompactionSnapshot {
  const { compacted } = splitRecentUserTurns(input.messages, input.preserveRecentUserTurns)
  const messages: Message[] = []
  const ledger = renderContextLedger(input.ledger)
  if (ledger) messages.push(textMessage("system", ledger))
  if (input.summary) messages.push(createMessage("system", [summaryPart(`Previous summary:\n${input.summary}`)]))
  messages.push(...redactProtectedMessages(compacted))
  return {
    providerMessages: messagesToProviderInput(messages, { redactProtectedToolResults: true, toolResultTokenBudget: historicalToolResultTokenBudget(input.toolResultTokenBudget) }),
    compactedMessageCount: compacted.length,
    messageCount: input.messages.length,
    previousSummary: input.summary,
  }
}

export function buildProviderMessages(input: {
  agent?: Agent
  instructions?: InstructionInfo[]
  skills?: SkillInfo[]
  selectedSkills?: SkillInfo[]
  pendingSkillLoads?: SkillInfo[]
  tools?: ToolDef[]
  summary?: string
  messages: Message[]
  toolResultTokenBudget?: number
}): ProviderInputMessage[] {
  const messages: Message[] = []
  if (input.agent && input.skills && input.tools) {
    messages.push(textMessage("system", buildContextSystemPrompt(input.agent)))
    const instructionPrompt = buildInstructionPrompt(input.instructions ?? [])
    if (instructionPrompt) messages.push(textMessage("system", instructionPrompt))
    const skillPrompt = buildSkillPrompt(input.skills, input.selectedSkills ?? [], input.pendingSkillLoads ?? [])
    if (skillPrompt) messages.push(textMessage("system", skillPrompt))
  }
  if (input.summary) messages.push(createMessage("system", [summaryPart(input.summary)]))
  const dynamicMessages = validProviderMessageSuffix(input.messages)
  messages.push(...dynamicMessages)
  return messagesToProviderInput(messages, { toolResultTokenBudget: input.toolResultTokenBudget })
}

function historicalToolResultTokenBudget(current?: number) {
  return current === undefined ? undefined : Math.max(300, Math.floor(current * 0.5))
}
