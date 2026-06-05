import { estimateMessages, splitRecentUserTurns } from "../context"
import { validProviderMessageSuffix, type Message } from "../message"

export function persistedSessionMessages(messages: Message[], preserveRecentUserTurns: number, compactPreserveTokens: number) {
  const recent = splitRecentUserTurns(messages, preserveRecentUserTurns).recent
  return recentSessionMessageSuffix(recent, compactPreserveTokens)
}

export function recentSessionMessageSuffix(messages: Message[], maxTokens = 3_000) {
  const userTurnStarts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []))
  if (userTurnStarts.length === 0) return greedySessionMessageSuffix(messages, maxTokens)

  const latestTurnStart = userTurnStarts[userTurnStarts.length - 1]
  const latestTurn = validProviderMessageSuffix(messages.slice(latestTurnStart))

  // For persisted sessions, prefer keeping the latest answered turn even when it
  // exceeds the preserve budget; otherwise restored sessions can replay an already
  // answered request because the summary lags behind the fresh tail.
  if (estimateMessages(latestTurn) > maxTokens) {
    return latestTurn.length > 1 ? latestTurn : validProviderMessageSuffix([messages[latestTurnStart]])
  }

  let preserved = latestTurn
  for (let index = userTurnStarts.length - 2; index >= 0; index -= 1) {
    const candidate = validProviderMessageSuffix(messages.slice(userTurnStarts[index]))
    if (estimateMessages(candidate) > maxTokens) break
    preserved = candidate
  }
  return preserved
}

export function greedySessionMessageSuffix(messages: Message[], maxTokens: number) {
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
