import { messagesToProviderInput, validProviderMessageSuffix, type Message } from "../message"

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
    if (candidate.length === 0) {
      if (messages[index].role === "tool") suffix.unshift(messages[index])
      continue
    }
    if (estimateMessages(candidate) > maxTokens && suffix.length > 0) break
    suffix.unshift(messages[index])
  }
  return validProviderMessageSuffix(suffix)
}

export function splitRecentUserTurns(messages: Message[], preserveRecentUserTurns: number) {
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

export function estimateMessages(messages: Message[]) {
  return estimateTextTokens(messagesToProviderInput(messages).map((message) => message.content).join("\n"))
}

