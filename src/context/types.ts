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
  staticPrefixTokens: number
}

export type ContextBudgetStats = {
  tokenEstimate: number
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

export type ContextRunOutcome = {
  status: "completed" | "failed"
  failureReason?: "provider_error" | "max_steps"
}

export interface ContextManagerLike {
  readonly state: ContextState
  readonly strategyState: ContextStrategyState
  readonly compactAt: number
  readonly preserveRecentUserTurns: number
  readonly compactPreserveTokens: number
  add(message: Message): void
  setLedger(ledger: ContextLedger | undefined): void
  updateLedger(patch: ContextLedger): void
  clearLedger(): void
  estimate(messages: Message[]): number
  configureStrategy(input: Partial<ContextStrategyState> & { responseReserveTokens?: number; contextWindowTokens?: number }): void
  recordUsage(inputTokens: number): void
  observeUsage(observation: ContextUsageObservation): void
  recordRunOutcome(outcome: ContextRunOutcome): void
  needsCompaction(): boolean
  compactionInput(): ProviderInputMessage[]
  compact(summary: string): boolean
  planRequest(input: ContextPlanInput): ContextPlan
  compose(input?: { agent: Agent; skills: SkillInfo[]; selectedSkills?: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[]
}

