import { defaultCachePricing, type CachePricing } from "../cache-policy"
import type { InstructionInfo } from "../instruction"
import { canonicalizeHistoryMessage, messagesToProviderInput, type Message, type ProviderInputMessage } from "../message"
import type { Agent } from "../agent"
import { hasSkillPrompt } from "../prompt"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"
import { mergeLedger, normalizedLedger, renderContextLedger, selectContextLedger, validateLedger } from "./ledger"
import { createCompactionResult, createSnapshotCompactionResult } from "./manager-compaction"
import { buildCompactionSnapshot, buildProviderMessages } from "./manager-compose"
import { addWindowStats, cloneStrategy, emptyWindowStats, estimateStaticPrefixTokens, staticPrefixMessageCount, type WindowStats } from "./manager-helpers"
import { createBudgetStats, createCacheStats, createLedgerStats, ledgerTokenBudget, renderSelectedLedgerText, compactionBasis } from "./manager-stats"
import { clampStrategyState, createInitialStrategyState, defaultCompactPreserveTokens, defaultSafetyMultiplier, initialMaxTokens, maxSafetyMultiplier, minMaxTokens, minSafetyMultiplier, minTokenFloorForOptions, responseReserveTokensForMax, safetyMultiplierForOptions } from "./strategy"
import { estimateSummaryTokens, estimateTextTokens, recentProviderMessageSuffix } from "./tokens"
import type { ContextBudgetStats, ContextCacheStats, ContextCompactionSnapshot, ContextLedger, ContextLedgerStats, ContextManagerLike, ContextOptions, ContextPlan, ContextPlanInput, ContextState, ContextStrategyState, ContextUsageObservation } from "./types"

export class ContextManager implements ContextManagerLike {
  readonly state: ContextState
  readonly compactPreserveTokens: number
  private readonly pricing: CachePricing
  private readonly minTokenFloor: number
  private readonly safetyMultiplier: number
  private responseReserveTokens: number
  private contextWindowTokens: number
  private totalStats: WindowStats = emptyWindowStats()
  private _strategyState: ContextStrategyState
  private lastStaticPrefixTokens = 0

  constructor(options: ContextOptions = {}) {
    this.minTokenFloor = minTokenFloorForOptions(options)
    const maxTokens = initialMaxTokens(options, this.minTokenFloor)
    this.contextWindowTokens = options.contextWindowTokens ?? maxTokens
    this.responseReserveTokens = responseReserveTokensForMax(maxTokens, options.responseReserveTokens)
    this.pricing = options.pricing ?? defaultCachePricing()
    // Keep enough raw tail after compaction to usually retain the configured
    // recent-turn window instead of collapsing immediately to one turn.
    this.compactPreserveTokens = options.compactPreserveTokens ?? defaultCompactPreserveTokens(maxTokens)
    this.safetyMultiplier = safetyMultiplierForOptions(options)
    this._strategyState = createInitialStrategyState(options, maxTokens)
    this.state = { messages: [], tokenEstimate: 0, maxTokens }
  }

  get strategyState() {
    return cloneStrategy(this._strategyState)
  }

  get compactAt() {
    return this._strategyState.compactAt
  }

  get preserveRecentUserTurns() {
    return this._strategyState.activeWindowUserTurns
  }

  add(message: Message) {
    this.state.messages.push(canonicalizeHistoryMessage(message))
    this.recalculateTokenEstimate()
  }

  setLedger(ledger: ContextLedger | undefined) {
    this.state.ledger = normalizedLedger(ledger)
    this.recalculateTokenEstimate()
  }

  updateLedger(patch: ContextLedger) {
    this.setLedger(mergeLedger(this.state.ledger, patch))
  }

  clearLedger() {
    this.setLedger(undefined)
  }

  estimate(messages: Message[]) {
    return estimateTextTokens(messagesToProviderInput(messages, { toolResultTokenBudget: this._strategyState.toolResultTokenBudget }).map((message) => message.content).join("\n"))
  }

  recordUsage(inputTokens: number) {
    this.state.latestActualInputTokens = inputTokens
  }

  configureStrategy(input: Partial<ContextStrategyState> & { responseReserveTokens?: number; contextWindowTokens?: number }) {
    if (input.contextWindowTokens !== undefined) this.contextWindowTokens = Math.max(minMaxTokens, input.contextWindowTokens)
    if (input.responseReserveTokens !== undefined) this.responseReserveTokens = Math.max(0, input.responseReserveTokens)
    this.applyStrategy({ ...this._strategyState, ...input })
  }

  observeUsage(observation: ContextUsageObservation) {
    this.recordUsage(observation.inputTokens)
    const hit = observation.cacheHitTokens ?? 0
    const miss = observation.cacheMissTokens ?? Math.max(0, observation.inputTokens - hit)
    const normalized = { calls: 1, inputTokens: observation.inputTokens, outputTokens: observation.outputTokens, cacheHitTokens: hit, cacheMissTokens: miss }
    addWindowStats(this.totalStats, normalized)
  }

  needsCompaction() {
    return this.compactionBasis() > this.state.maxTokens * this.compactAt
  }

  compactionInput() {
    return this.compactionSnapshot()?.providerMessages ?? []
  }

  compactionSnapshot(): ContextCompactionSnapshot | undefined {
    if (!this.needsCompaction()) return undefined
    const snapshot = buildCompactionSnapshot({
      messages: this.state.messages,
      preserveRecentUserTurns: this.preserveRecentUserTurns,
      ledger: this.state.ledger,
      summary: this.state.summary,
      toolResultTokenBudget: this._strategyState.toolResultTokenBudget,
    })
    if (this.state.summary && snapshot.compactedMessageCount === 0) {
      const preserved = recentProviderMessageSuffix(this.state.messages, this.compactPreserveTokens)
      if (sameMessageSequence(preserved, this.state.messages)) return undefined
    }
    return snapshot
  }

  compact(summary: string) {
    if (!this.needsCompaction()) return false
    const result = createCompactionResult({
      messages: this.state.messages,
      preserveRecentUserTurns: this.preserveRecentUserTurns,
      compactPreserveTokens: this.compactPreserveTokens,
      summary,
      dynamicSummaryTokenBudget: this._strategyState.dynamicSummaryTokenBudget,
      ledger: this.state.ledger,
      turn: this.state.messages.length,
    })
    const conflicts = result.conflicts
    if (conflicts.length) this.state.ledger = mergeLedger(this.state.ledger, { current: conflicts })
    this.state.summary = result.nextSummary
    this.state.messages = result.preservedMessages
    this.lastStaticPrefixTokens = 0
    this.state.latestActualInputTokens = undefined
    this.recalculateTokenEstimate()
    return true
  }

  compactSnapshot(summary: string, snapshot: ContextCompactionSnapshot) {
    if (snapshot.compactedMessageCount < 0) return false
    if (this.state.messages.length < snapshot.messageCount) return false
    if (this.state.summary !== snapshot.previousSummary) return false
    const result = createSnapshotCompactionResult({
      messages: this.state.messages,
      snapshot,
      compactPreserveTokens: this.compactPreserveTokens,
      summary,
      dynamicSummaryTokenBudget: this._strategyState.dynamicSummaryTokenBudget,
      ledger: this.state.ledger,
      turn: this.state.messages.length,
    })
    if (!result) return false
    const conflicts = result.conflicts
    if (conflicts.length) this.state.ledger = mergeLedger(this.state.ledger, { current: conflicts })
    this.state.summary = result.nextSummary
    this.state.messages = result.preservedMessages
    this.lastStaticPrefixTokens = 0
    this.state.latestActualInputTokens = undefined
    this.recalculateTokenEstimate()
    return true
  }

  planRequest(input: ContextPlanInput): ContextPlan {
    const providerMessages = this.compose(input)
    const ledgerStats = this.ledgerStats()
    const staticPrefixTokens = estimateStaticPrefixTokens(providerMessages, staticPrefixMessageCount(input))
    this.lastStaticPrefixTokens = staticPrefixTokens
    this.maxStaticPrefixTokens = Math.max(this.maxStaticPrefixTokens, staticPrefixTokens)
    return {
      providerMessages,
      strategyState: this.strategyState,
      cacheStats: this.cacheStats(staticPrefixTokens),
      budgetStats: this.budgetStats(),
      ledgerStats,
    }
  }

  compose(input?: { agent: Agent; instructions?: InstructionInfo[]; skills: SkillInfo[]; selectedSkills?: SkillInfo[]; pendingSkillLoads?: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[] {
    return buildProviderMessages({
      ...(input ?? {}),
      summary: this.state.summary,
      messages: this.state.messages,
      toolResultTokenBudget: this._strategyState.toolResultTokenBudget,
    })
  }

  selectedLedgerText() {
    return renderSelectedLedgerText(this.state.ledger, this.state.messages, this.ledgerTokenBudget())
  }

  private recalculateTokenEstimate() {
    const messageProviderInput = messagesToProviderInput(this.state.messages, { toolResultTokenBudget: this._strategyState.toolResultTokenBudget })
    const messageTokens = estimateTextTokens(messageProviderInput.map((message) => message.content).join("\n"))
    this.state.tokenEstimate = messageTokens + estimateSummaryTokens(this.state.summary)
  }

  private maxStaticPrefixTokens = 0

  private cacheStats(currentStaticPrefixTokens: number): ContextCacheStats {
    return createCacheStats(this.totalStats, this.pricing, currentStaticPrefixTokens, this.maxStaticPrefixTokens)
  }

  private budgetStats(): ContextBudgetStats {
    return createBudgetStats({
      tokenEstimate: this.state.tokenEstimate,
      lastStaticPrefixTokens: this.lastStaticPrefixTokens,
      safetyMultiplier: this.safetyMultiplier,
      maxTokens: this.state.maxTokens,
      compactAt: this.compactAt,
      responseReserveTokens: this.responseReserveTokens,
      latestActualInputTokens: this.state.latestActualInputTokens,
      ledgerStats: this.ledgerStats(),
    })
  }

  private compactionBasis() {
    return compactionBasis(this.state.tokenEstimate, this.safetyMultiplier, this.lastStaticPrefixTokens, this.state.latestActualInputTokens)
  }

  private selectedLedger() {
    return selectContextLedger(this.state.ledger, this.state.messages, this.ledgerTokenBudget())
  }

  private renderSelectedLedger() {
    return renderContextLedger(this.selectedLedger())
  }

  private ledgerStats(): ContextLedgerStats {
    return createLedgerStats(this.state.ledger, this.state.messages, this.ledgerTokenBudget())
  }

  private ledgerTokenBudget() {
    return ledgerTokenBudget(this.state.maxTokens, this.responseReserveTokens)
  }

  private applyStrategy(input: ContextStrategyState) {
    this._strategyState = clampStrategyState(input, this.minTokenFloor, this.contextWindowTokens)
    this.state.maxTokens = this._strategyState.maxTokens
  }
}

function sameMessageSequence(left: Message[], right: Message[]) {
  return left.length === right.length && left.every((message, index) => message === right[index])
}
