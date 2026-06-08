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
