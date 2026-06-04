import type { Message } from "../message"
import { normalizedLedger, summaryLedgerConflicts } from "./ledger"
import { truncateToTokenBudget } from "./manager-helpers"
import { recentProviderMessageSuffix, splitRecentUserTurns } from "./tokens"
import type { ContextCompactionSnapshot, ContextLedger } from "./types"

type CompactionResult = {
  nextSummary: string
  preservedMessages: Message[]
  conflicts: NonNullable<ReturnType<typeof summaryLedgerConflicts>>
}

export function createCompactionResult(input: {
  messages: Message[]
  preserveRecentUserTurns: number
  compactPreserveTokens: number
  summary: string
  dynamicSummaryTokenBudget: number
  ledger: ContextLedger | undefined
  turn: number
}): CompactionResult {
  const { recent } = splitRecentUserTurns(input.messages, input.preserveRecentUserTurns)
  const preservedMessages = recentProviderMessageSuffix(recent, input.compactPreserveTokens)
  const nextSummary = truncateToTokenBudget(input.summary, input.dynamicSummaryTokenBudget)
  const conflicts = summaryLedgerConflicts(nextSummary, normalizedLedger(input.ledger), input.turn)
  return { nextSummary, preservedMessages, conflicts }
}

export function createSnapshotCompactionResult(input: {
  messages: Message[]
  snapshot: ContextCompactionSnapshot
  compactPreserveTokens: number
  summary: string
  dynamicSummaryTokenBudget: number
  ledger: ContextLedger | undefined
  turn: number
}) {
  if (input.snapshot.compactedMessageCount < 0) return undefined
  if (input.messages.length < input.snapshot.messageCount) return undefined
  const preservedMessages = recentProviderMessageSuffix(
    input.messages.slice(input.snapshot.compactedMessageCount),
    input.compactPreserveTokens,
  )
  const nextSummary = truncateToTokenBudget(input.summary, input.dynamicSummaryTokenBudget)
  const conflicts = summaryLedgerConflicts(nextSummary, normalizedLedger(input.ledger), input.turn)
  return { nextSummary, preservedMessages, conflicts }
}
