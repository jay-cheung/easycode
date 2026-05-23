import type { Agent } from "../agent"
import type { CachePricing } from "../cache-policy"
import type { Message, ProviderInputMessage } from "../message"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"

export type ContextState = {
  messages: Message[]
  summary?: string
  ledger?: StructuredContextLedger
  tokenEstimate: number
  maxTokens: number
  latestActualInputTokens?: number
}

export type LedgerKind = "intent" | "decision" | "constraint" | "preference" | "entity" | "file" | "failure" | "checkpoint" | "conflict"
export type LedgerStatus = "current" | "superseded" | "rejected" | "resolved" | "archived"

export type LedgerScope = {
  taskID?: string
  files?: string[]
  symbols?: string[]
  topics?: string[]
}

export type LedgerEvidence = {
  source: "user" | "assistant" | "tool" | "summary"
  messageIndex?: number
  toolCallID?: string
}

export type LedgerRecord = {
  id: string
  kind: LedgerKind
  subject: string
  value: string
  status: LedgerStatus
  scope?: LedgerScope
  reason?: string
  evidence?: LedgerEvidence
  createdAtTurn: number
  updatedAtTurn: number
  supersedes?: string[]
}

export type StructuredContextLedger = {
  current: LedgerRecord[]
  history: LedgerRecord[]
}

export type ContextLedger = Partial<StructuredContextLedger>

export type ContextOptions = {
  maxTokens?: number
  compactAt?: number
  preserveRecentUserTurns?: number
  compactPreserveTokens?: number
  maxSteps?: number
  activeWindowUserTurns?: number
  toolResultTokenBudget?: number
  dynamicSummaryTokenBudget?: number
  responseReserveTokens?: number
  contextWindowTokens?: number
  pricing?: CachePricing
  tokenEstimateSafetyMultiplier?: number
}

export type ContextStrategyState = {
  staticContextStrategy: "every-step"
  maxTokens: number
  compactAt: number
  activeWindowUserTurns: number
  toolResultTokenBudget: number
  dynamicSummaryTokenBudget: number
  maxSteps: number
}

export type ContextCacheStats = {
  observedCalls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  hitRate: number
  effectiveCost: number
  effectiveCostPerCall: number
  currentStaticPrefixTokens: number
  maxStaticPrefixTokens: number
  staticPrefixTokens: number
}

export type ContextBudgetStats = {
  tokenEstimate: number
  compactionBasis: number
  staticPrefixTokens: number
  safetyMultiplier: number
  maxTokens: number
  compactAt: number
  responseReserveTokens: number
  availableInputTokens: number
  ledgerTokens: number
  selectedLedgerRecords: number
  ledgerConflicts: number
}

export type ContextPlan = {
  providerMessages: ProviderInputMessage[]
  strategyState: ContextStrategyState
  cacheStats: ContextCacheStats
  budgetStats: ContextBudgetStats
  ledgerStats: ContextLedgerStats
}

export type ContextLedgerStats = {
  currentRecords: number
  historyRecords: number
  selectedRecords: number
  selectedCurrentRecords: number
  selectedHistoryRecords: number
  tokenEstimate: number
  validationIssues: number
}

export type ContextPlanInput = {
  step: number
  agent: Agent
  skills: SkillInfo[]
  selectedSkills?: SkillInfo[]
  tools: ToolDef[]
}

export type ContextUsageObservation = {
  inputTokens: number
  outputTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

export interface ContextManagerLike {
  /**
   * Live manager state. This exposes the owned state object for persistence and
   * inspection; it is not a deep-readonly snapshot, so callers should not mutate
   * nested arrays or records directly.
   */
  readonly state: ContextState
  /** Current clamped strategy settings used by planning, budget checks, and compaction. */
  readonly strategyState: ContextStrategyState
  readonly compactAt: number
  readonly preserveRecentUserTurns: number
  readonly compactPreserveTokens: number
  /** Append a conversation message and refresh the message/summary token estimate. */
  add(message: Message): void
  /** Replace the structured ledger with a normalized copy, or clear it with undefined. */
  setLedger(ledger: ContextLedger | undefined): void
  /** Merge a partial ledger patch into the current ledger using ledger keys and history rules. */
  updateLedger(patch: ContextLedger): void
  /** Clear the structured ledger without changing message history or summary. */
  clearLedger(): void
  /** Estimate provider-input tokens for the supplied messages using the local heuristic. */
  estimate(messages: Message[]): number
  /** Clamp and apply strategy updates; changes affect subsequent budgets and compaction checks. */
  configureStrategy(input: Partial<ContextStrategyState> & { responseReserveTokens?: number; contextWindowTokens?: number }): void
  recordUsage(inputTokens: number): void
  observeUsage(observation: ContextUsageObservation): void
  /** Return whether the current message/summary state exceeds the compaction threshold. */
  needsCompaction(): boolean
  /** Build the provider-safe messages used to ask the model for a compaction summary. */
  compactionInput(): ProviderInputMessage[]
  /** Compact history with the supplied summary; false means the threshold was not reached. */
  compact(summary: string): boolean
  /** Compose provider messages and attach budget/cache/ledger stats for the next provider call. */
  planRequest(input: ContextPlanInput): ContextPlan
  /** Build provider input messages; planRequest calls this and then computes stats. */
  compose(input?: { agent: Agent; skills: SkillInfo[]; selectedSkills?: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[]
  /** Render the currently selected ledger records for the ledger tool. */
  selectedLedgerText(): string
}
