import type { CachePricing } from "../cache-policy"
import type { Message } from "../message"
import { normalizedLedger, renderContextLedger, selectContextLedger, validateLedger } from "./ledger"
import { estimateTextTokens } from "./tokens"
import type { ContextBudgetStats, ContextCacheStats, ContextLedger, ContextLedgerStats } from "./types"
import type { WindowStats } from "./manager-helpers"

export function createCacheStats(
  totalStats: WindowStats,
  pricing: CachePricing,
  currentStaticPrefixTokens: number,
  maxStaticPrefixTokens: number,
) {
  const hitRate = totalStats.inputTokens === 0 ? 0 : totalStats.cacheHitTokens / totalStats.inputTokens
  const effectiveCost = totalStats.cacheMissTokens * pricing.inputCacheMiss + totalStats.cacheHitTokens * pricing.inputCacheHit
  return {
    observedCalls: totalStats.calls,
    inputTokens: totalStats.inputTokens,
    outputTokens: totalStats.outputTokens,
    cacheHitTokens: totalStats.cacheHitTokens,
    cacheMissTokens: totalStats.cacheMissTokens,
    hitRate,
    effectiveCost,
    effectiveCostPerCall: totalStats.calls === 0 ? 0 : effectiveCost / totalStats.calls,
    currentStaticPrefixTokens,
    maxStaticPrefixTokens,
    staticPrefixTokens: currentStaticPrefixTokens,
  } satisfies ContextCacheStats
}

export function compactionBasis(tokenEstimate: number, safetyMultiplier: number, lastStaticPrefixTokens: number, latestActualInputTokens?: number) {
  const inflatedEstimate = Math.ceil(tokenEstimate * safetyMultiplier) + lastStaticPrefixTokens
  const actual = latestActualInputTokens ?? 0
  return Math.max(inflatedEstimate, actual)
}

export function ledgerTokenBudget(maxTokens: number, responseReserveTokens: number) {
  const dynamicBudget = Math.max(0, maxTokens - responseReserveTokens)
  return Math.max(400, Math.floor(dynamicBudget * 0.15))
}

export function selectedLedger(ledger: ContextLedger | undefined, messages: Message[], tokenBudget: number) {
  return selectContextLedger(ledger, messages, tokenBudget)
}

export function renderSelectedLedgerText(ledger: ContextLedger | undefined, messages: Message[], tokenBudget: number) {
  return renderContextLedger(selectedLedger(ledger, messages, tokenBudget))
}

export function createLedgerStats(ledger: ContextLedger | undefined, messages: Message[], tokenBudget: number) {
  const normalized = normalizedLedger(ledger)
  const selected = selectContextLedger(normalized, messages, tokenBudget)
  return {
    currentRecords: normalized?.current.length ?? 0,
    historyRecords: normalized?.history.length ?? 0,
    selectedRecords: (selected?.current.length ?? 0) + (selected?.history.length ?? 0),
    selectedCurrentRecords: selected?.current.length ?? 0,
    selectedHistoryRecords: selected?.history.length ?? 0,
    tokenEstimate: estimateTextTokens(renderContextLedger(selected)),
    validationIssues: validateLedger(normalized).length,
  } satisfies ContextLedgerStats
}

export function createBudgetStats(input: {
  tokenEstimate: number
  lastStaticPrefixTokens: number
  safetyMultiplier: number
  maxTokens: number
  compactAt: number
  responseReserveTokens: number
  latestActualInputTokens?: number
  ledgerStats: ContextLedgerStats
}) {
  return {
    tokenEstimate: input.tokenEstimate,
    compactionBasis: compactionBasis(
      input.tokenEstimate,
      input.safetyMultiplier,
      input.lastStaticPrefixTokens,
      input.latestActualInputTokens,
    ),
    staticPrefixTokens: input.lastStaticPrefixTokens,
    safetyMultiplier: input.safetyMultiplier,
    maxTokens: input.maxTokens,
    compactAt: input.compactAt,
    responseReserveTokens: input.responseReserveTokens,
    availableInputTokens: Math.max(0, input.maxTokens - input.responseReserveTokens),
    ledgerTokens: input.ledgerStats.tokenEstimate,
    selectedLedgerRecords: input.ledgerStats.selectedRecords,
    ledgerConflicts: input.ledgerStats.validationIssues,
  } satisfies ContextBudgetStats
}
