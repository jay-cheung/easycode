import { messagesToProviderInput, validProviderMessageSuffix, type Message } from "../message"

/**
 * Estimate text tokens with a local heuristic for budget decisions.
 * This is not a provider tokenizer and must not be used as billing truth.
 */
export function estimateTextTokens(text: string) {
  let tokens = 0
  for (const char of text) tokens += isCJK(char) ? 0.6 : 0.3
  return Math.ceil(tokens)
}

/** Estimate the budget cost of a summary after wrapping it like provider input. */
export function estimateSummaryTokens(summary: string | undefined) {
  if (!summary) return 0
  return estimateTextTokens(messageToSummaryText(summary))
}

/**
 * Keep the last user turns while preserving provider-valid tool call/result pairs.
 * Used for active conversation context after older turns become compaction input.
 */
export function recentUserTurnMessages(messages: Message[], preserveRecentUserTurns = 3) {
  return validProviderMessageSuffix(splitRecentUserTurns(messages, preserveRecentUserTurns).recent)
}

/**
 * Trim a recent suffix to the token budget without leaving orphan tool results
 * or unmatched tool calls in provider history.
 */
export function recentProviderMessageSuffix(messages: Message[], maxTokens = 3_000) {
  const userTurnStarts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []))
  if (userTurnStarts.length === 0) return greedyProviderMessageSuffix(messages, maxTokens)

  const latestTurnStart = userTurnStarts[userTurnStarts.length - 1]
  const latestTurn = validProviderMessageSuffix(messages.slice(latestTurnStart))

  // Prefer preserving the latest user turn instead of leaving only an
  // assistant tail after compaction or session pruning.
  if (estimateMessages(latestTurn) > maxTokens) return validProviderMessageSuffix([messages[latestTurnStart]])

  let preserved = latestTurn
  for (let index = userTurnStarts.length - 2; index >= 0; index -= 1) {
    const candidate = validProviderMessageSuffix(messages.slice(userTurnStarts[index]))
    if (estimateMessages(candidate) > maxTokens) break
    preserved = candidate
  }
  return preserved
}

/** Split history into compacted turns and the recent active window by user turns. */
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

/** Estimate tokens for messages after the same text conversion used for provider input. */
export function estimateMessages(messages: Message[]) {
  return estimateTextTokens(messagesToProviderInput(messages).map((message) => message.content).join("\n"))
}

function greedyProviderMessageSuffix(messages: Message[], maxTokens: number) {
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
