import type { Agent } from "../agent"
import { defaultCachePricing, type CachePricing, type CacheStrategy, type StaticContextStrategy } from "../cache-policy"
import { createMessage, messagesToProviderInput, redactProtectedMessages, summaryPart, textMessage, validProviderMessageSuffix, type Message, type ProviderInputMessage } from "../message"
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
  adaptiveEnabled?: boolean
}

export type ContextStrategyState = {
  staticContextStrategy: StaticContextStrategy
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

export type ContextAdaptiveState = {
  acceptedStrategyRevision: number
  acceptedAdjustments: number
  rollbacks: number
  pendingAdjustment?: string
  lastAdjustment?: string
}

export type ContextPlan = {
  providerMessages: ProviderInputMessage[]
  strategyState: ContextStrategyState
  cacheStats: ContextCacheStats
  budgetStats: ContextBudgetStats
  acceptedStrategyRevision: number
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
  cacheStrategy: CacheStrategy
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
  readonly adaptiveState: ContextAdaptiveState
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

type WindowStats = {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  maxStepFailures: number
}

type AdjustmentName = "toolResultTokenBudget" | "maxTokens" | "compactAt" | "activeWindowUserTurns" | "dynamicSummaryTokenBudget" | "maxSteps" | "staticContextStrategy"

const defaultMaxTokens = 32_000
const defaultMaxSteps = 20
const minMaxTokens = 16_000
const minMaxSteps = 8
const maxMaxSteps = 30
const evaluationWindowCalls = 5
const acceptedCostImprovement = 0.02
const hitRateTolerance = 0.01
const adaptiveDegradationWindows = 2

export class ContextManager implements ContextManagerLike {
  readonly state: ContextState
  readonly compactPreserveTokens: number
  private readonly pricing: CachePricing
  private readonly minTokenFloor: number
  private responseReserveTokens: number
  private contextWindowTokens: number
  private readonly adaptiveEnabled: boolean
  private lastCacheStrategy: CacheStrategy = "cache-heavy"
  private acceptedStrategyRevision = 0
  private acceptedStrategyState: ContextStrategyState
  private acceptedWindow?: WindowStats
  private pendingCandidate?: { adjustment: AdjustmentName; previous: ContextStrategyState }
  private readonly cooldowns = new Map<AdjustmentName, number>()
  private acceptedAdjustments = 0
  private rollbacks = 0
  private lastAdjustment?: AdjustmentName
  private everyStepNegativeWindows = 0
  private degradationWindows = 0
  private totalStats: WindowStats = emptyWindowStats()
  private currentWindow: WindowStats = emptyWindowStats()
  private _strategyState: ContextStrategyState

  constructor(options: ContextOptions = {}) {
    this.minTokenFloor = options.maxTokens !== undefined && options.maxTokens < minMaxTokens ? Math.max(1, Math.round(options.maxTokens)) : minMaxTokens
    const maxTokens = clampInt(options.maxTokens ?? defaultMaxTokens, this.minTokenFloor, options.contextWindowTokens ?? Number.MAX_SAFE_INTEGER)
    this.contextWindowTokens = options.contextWindowTokens ?? maxTokens
    this.adaptiveEnabled = options.adaptiveEnabled ?? true
    this.responseReserveTokens = options.responseReserveTokens ?? Math.max(2_000, Math.min(8_000, Math.floor(maxTokens * 0.2)))
    this.pricing = options.pricing ?? defaultCachePricing()
    this.compactPreserveTokens = options.compactPreserveTokens ?? 1_000
    this._strategyState = {
      staticContextStrategy: "every-step",
      maxTokens,
      compactAt: clampNumber(options.compactAt ?? 0.75, 0.6, 0.9),
      activeWindowUserTurns: clampInt(options.activeWindowUserTurns ?? options.preserveRecentUserTurns ?? 3, 1, 10),
      toolResultTokenBudget: clampInt(options.toolResultTokenBudget ?? 1_200, 300, 4_000),
      dynamicSummaryTokenBudget: clampInt(options.dynamicSummaryTokenBudget ?? 3_000, 800, 8_000),
      maxSteps: clampInt(options.maxSteps ?? defaultMaxSteps, minMaxSteps, maxMaxSteps),
    }
    this.acceptedStrategyState = cloneStrategy(this._strategyState)
    this.state = { messages: [], tokenEstimate: 0, maxTokens }
  }

  get strategyState() {
    return cloneStrategy(this._strategyState)
  }

  get adaptiveState(): ContextAdaptiveState {
    return {
      acceptedStrategyRevision: this.acceptedStrategyRevision,
      acceptedAdjustments: this.acceptedAdjustments,
      rollbacks: this.rollbacks,
      pendingAdjustment: this.pendingCandidate?.adjustment,
      lastAdjustment: this.lastAdjustment,
    }
  }

  get compactAt() {
    return this._strategyState.compactAt
  }

  get preserveRecentUserTurns() {
    return this._strategyState.activeWindowUserTurns
  }

  add(message: Message) {
    this.state.messages.push(message)
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
    return estimateTextTokens(messagesToProviderInput(messages).map((message) => message.content).join("\n"))
  }

  recordUsage(inputTokens: number) {
    this.state.latestActualInputTokens = inputTokens
  }

  configureStrategy(input: Partial<ContextStrategyState> & { responseReserveTokens?: number; contextWindowTokens?: number }) {
    if (input.contextWindowTokens !== undefined) this.contextWindowTokens = Math.max(minMaxTokens, input.contextWindowTokens)
    if (input.responseReserveTokens !== undefined) this.responseReserveTokens = Math.max(0, input.responseReserveTokens)
    this.applyStrategy({ ...this._strategyState, ...input })
    this.acceptedStrategyState = cloneStrategy(this._strategyState)
  }

  observeUsage(observation: ContextUsageObservation) {
    this.recordUsage(observation.inputTokens)
    const hit = observation.cacheHitTokens ?? 0
    const miss = observation.cacheMissTokens ?? Math.max(0, observation.inputTokens - hit)
    const normalized = { calls: 1, inputTokens: observation.inputTokens, outputTokens: observation.outputTokens, cacheHitTokens: hit, cacheMissTokens: miss, maxStepFailures: 0 }
    addWindowStats(this.totalStats, normalized)
    addWindowStats(this.currentWindow, normalized)
    if (this.adaptiveEnabled && this.lastCacheStrategy === "auto" && this.currentWindow.calls >= evaluationWindowCalls) this.evaluateAdaptiveWindow()
  }

  recordRunOutcome(outcome: ContextRunOutcome) {
    if (outcome.failureReason === "max_steps") {
      this.currentWindow.maxStepFailures += 1
      this.totalStats.maxStepFailures += 1
      if (this.adaptiveEnabled && this.lastCacheStrategy === "auto") this.handleMaxStepPressure()
    }
  }

  needsCompaction() {
    return this.state.tokenEstimate > this.state.maxTokens * this.compactAt
  }

  compactionInput() {
    if (!this.needsCompaction()) return []
    const { compacted } = splitRecentUserTurns(this.state.messages, this.preserveRecentUserTurns)
    const messages: Message[] = []
    const ledger = renderContextLedger(this.state.ledger)
    if (ledger) messages.push(textMessage("system", ledger))
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(`Previous summary:\n${this.state.summary}`)]))
    messages.push(...redactProtectedMessages(compacted))
    return messagesToProviderInput(messages, { redactProtectedToolResults: true })
  }

  compact(summary: string) {
    if (!this.needsCompaction()) return false
    const { recent } = splitRecentUserTurns(this.state.messages, this.preserveRecentUserTurns)
    const preserved = recentProviderMessageSuffix(recent, this.compactPreserveTokens)
    const nextSummary = truncateToTokenBudget(summary, this._strategyState.dynamicSummaryTokenBudget)
    const conflicts = summaryLedgerConflicts(nextSummary, this.state.ledger, this.state.messages.length)
    if (conflicts.length) this.state.ledger = mergeLedger(this.state.ledger, { current: conflicts })
    this.state.summary = nextSummary
    this.state.messages = preserved
    this.recalculateTokenEstimate()
    return true
  }

  planRequest(input: ContextPlanInput): ContextPlan {
    this.lastCacheStrategy = input.cacheStrategy
    const staticInput = shouldSendStaticContext(input.cacheStrategy, this._strategyState.staticContextStrategy, input.step) ? input : undefined
    const providerMessages = this.compose(staticInput)
    const ledgerStats = this.ledgerStats()
    const staticPrefixTokens = staticInput ? estimateStaticPrefixTokens(providerMessages) : 0
    this.staticPrefixTokens = Math.max(this.staticPrefixTokens, staticPrefixTokens)
    return {
      providerMessages,
      strategyState: this.strategyState,
      cacheStats: this.cacheStats(),
      budgetStats: this.budgetStats(),
      acceptedStrategyRevision: this.acceptedStrategyRevision,
      ledgerStats,
    }
  }

  compose(input?: { agent: Agent; skills: SkillInfo[]; selectedSkills?: SkillInfo[]; tools: ToolDef[] }): ProviderInputMessage[] {
    const messages: Message[] = []
    if (input) {
      const skills = sortedSkills(input.skills)
      const selected = sortedSkills(input.selectedSkills ?? []).map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") || "(none)"
      const skillList = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") || "(none)"
      const toolList = [...input.tools].sort((left, right) => left.name.localeCompare(right.name)).map((tool) => `- ${tool.name}: ${tool.description}\n  input_schema: ${stableStringify(tool.jsonSchema)}`).join("\n")
      const selectedSkillList = `Active skills, descriptions only. Load full instructions with the skill tool when needed:\n${selected}`
      const system = [input.agent.systemPrompt, contextExecutionContract, `Mode: ${input.agent.mode}`, `Available skills, descriptions only until skill tool is called:\n${skillList}`, `Selected skill instructions:\n${selectedSkillList}`, `Available tools:\n${toolList}`].join("\n\n")
      messages.push(textMessage("system", system))
    }
    const ledger = this.renderSelectedLedger()
    if (ledger) messages.push(textMessage("system", ledger))
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(this.state.summary)]))
    messages.push(...this.state.messages)
    return messagesToProviderInput(messages, { largeOutputLimit: Math.ceil(this._strategyState.toolResultTokenBudget / 0.3) })
  }

  private recalculateTokenEstimate() {
    this.state.tokenEstimate = this.estimate(this.state.messages) + estimateSummaryTokens(this.state.summary) + estimateTextTokens(this.renderSelectedLedger())
  }

  private staticPrefixTokens = 0

  private cacheStats(): ContextCacheStats {
    const hitRate = this.totalStats.inputTokens === 0 ? 0 : this.totalStats.cacheHitTokens / this.totalStats.inputTokens
    const totalEffectiveCost = effectiveWindowCost(this.totalStats, this.pricing)
    return {
      observedCalls: this.totalStats.calls,
      inputTokens: this.totalStats.inputTokens,
      outputTokens: this.totalStats.outputTokens,
      cacheHitTokens: this.totalStats.cacheHitTokens,
      cacheMissTokens: this.totalStats.cacheMissTokens,
      hitRate,
      effectiveCost: totalEffectiveCost,
      effectiveCostPerCall: this.totalStats.calls === 0 ? 0 : totalEffectiveCost / this.totalStats.calls,
      staticPrefixTokens: this.staticPrefixTokens,
    }
  }

  private budgetStats(): ContextBudgetStats {
    const stats = this.ledgerStats()
    return {
      tokenEstimate: this.state.tokenEstimate,
      maxTokens: this.state.maxTokens,
      compactAt: this.compactAt,
      responseReserveTokens: this.responseReserveTokens,
      availableInputTokens: Math.max(0, this.state.maxTokens - this.responseReserveTokens),
      ledgerTokens: stats.tokenEstimate,
      selectedLedgerRecords: stats.selectedRecords,
      ledgerConflicts: stats.validationIssues,
    }
  }

  private selectedLedger() {
    return selectContextLedger(this.state.ledger, this.state.messages, this.ledgerTokenBudget())
  }

  private renderSelectedLedger() {
    return renderContextLedger(this.selectedLedger())
  }

  private ledgerStats(): ContextLedgerStats {
    const ledger = normalizedLedger(this.state.ledger)
    const selected = selectContextLedger(ledger, this.state.messages, this.ledgerTokenBudget())
    return {
      currentRecords: ledger?.current.length ?? 0,
      historyRecords: ledger?.history.length ?? 0,
      selectedRecords: (selected?.current.length ?? 0) + (selected?.history.length ?? 0),
      selectedCurrentRecords: selected?.current.length ?? 0,
      selectedHistoryRecords: selected?.history.length ?? 0,
      tokenEstimate: estimateTextTokens(renderContextLedger(selected)),
      validationIssues: validateLedger(ledger).length,
    }
  }

  private ledgerTokenBudget() {
    const dynamicBudget = Math.max(0, this.state.maxTokens - this.responseReserveTokens)
    return Math.max(400, Math.floor(dynamicBudget * 0.15))
  }

  private evaluateAdaptiveWindow() {
    const window = this.currentWindow
    const currentMetrics = windowMetrics(window, this.pricing)
    if (this.pendingCandidate && this.acceptedWindow) {
      const accepted = windowMetrics(this.acceptedWindow, this.pricing)
      const acceptedCandidate = this.pendingCandidate.adjustment === "maxSteps" && window.maxStepFailures > 0
        ? true
        : currentMetrics.hitRate >= accepted.hitRate - hitRateTolerance && currentMetrics.costPerCall <= accepted.costPerCall * (1 - acceptedCostImprovement) && window.maxStepFailures === 0
      if (acceptedCandidate) {
        this.acceptedStrategyState = cloneStrategy(this._strategyState)
        this.acceptedWindow = cloneWindow(window)
        this.acceptedStrategyRevision += 1
        this.acceptedAdjustments += 1
        this.lastAdjustment = this.pendingCandidate.adjustment
        this.everyStepNegativeWindows = 0
        this.degradationWindows = 0
      } else {
        this.applyStrategy(this.acceptedStrategyState)
        this.cooldowns.set(this.pendingCandidate.adjustment, 2)
        this.rollbacks += 1
        this.lastAdjustment = this.pendingCandidate.adjustment
        this.degradationWindows = 0
        if (this.pendingCandidate.previous.staticContextStrategy === "every-step") this.everyStepNegativeWindows += 1
      }
      this.pendingCandidate = undefined
      this.currentWindow = emptyWindowStats()
      this.decayCooldowns()
      this.proposeCandidate(window.maxStepFailures > 0)
      return
    }

    if (this.acceptedWindow) {
      const accepted = windowMetrics(this.acceptedWindow, this.pricing)
      if (isDegradedWindow(currentMetrics, accepted)) {
        this.degradationWindows += 1
      } else {
        this.degradationWindows = 0
        this.acceptedStrategyState = cloneStrategy(this._strategyState)
        this.acceptedWindow = cloneWindow(window)
        this.acceptedStrategyRevision += 1
      }
    } else {
      this.acceptedStrategyState = cloneStrategy(this._strategyState)
      this.acceptedWindow = cloneWindow(window)
      this.acceptedStrategyRevision += 1
    }

    const shouldTryCandidate = this.degradationWindows >= adaptiveDegradationWindows
    this.currentWindow = emptyWindowStats()
    this.decayCooldowns()
    if (shouldTryCandidate) {
      this.degradationWindows = 0
      this.proposeCandidate(window.maxStepFailures > 0)
    }
  }

  private proposeCandidate(hadMaxStepFailure: boolean) {
    const adjustment = this.nextAdjustment(hadMaxStepFailure)
    if (!adjustment) return
    const previous = cloneStrategy(this._strategyState)
    const next = adjustedStrategy(previous, adjustment, this.contextWindowTokens)
    if (sameStrategy(previous, next)) return
    this.pendingCandidate = { adjustment, previous }
    this.applyStrategy(next)
  }

  private handleMaxStepPressure() {
    if (this.pendingCandidate) {
      if (this.pendingCandidate.adjustment === "maxSteps") {
        this.acceptedStrategyState = cloneStrategy(this._strategyState)
        this.acceptedStrategyRevision += 1
        this.acceptedAdjustments += 1
        this.lastAdjustment = "maxSteps"
        this.pendingCandidate = undefined
      } else {
        this.applyStrategy(this.acceptedStrategyState)
        this.cooldowns.set(this.pendingCandidate.adjustment, 2)
        this.rollbacks += 1
        this.lastAdjustment = this.pendingCandidate.adjustment
        this.pendingCandidate = undefined
      }
    }
    if (this.cooldowns.has("maxSteps")) return
    const previous = cloneStrategy(this._strategyState)
    const next = adjustedStrategy(previous, "maxSteps", this.contextWindowTokens)
    if (sameStrategy(previous, next)) return
    this.pendingCandidate = { adjustment: "maxSteps", previous }
    this.applyStrategy(next)
  }

  private nextAdjustment(hadMaxStepFailure: boolean): AdjustmentName | undefined {
    if (hadMaxStepFailure && !this.cooldowns.has("maxSteps")) return "maxSteps"
    if (this.everyStepNegativeWindows >= 2 && this._strategyState.staticContextStrategy === "every-step" && !this.cooldowns.has("staticContextStrategy")) return "staticContextStrategy"
    for (const adjustment of ["toolResultTokenBudget", "maxTokens", "compactAt", "activeWindowUserTurns", "dynamicSummaryTokenBudget", "maxSteps"] as AdjustmentName[]) {
      if (!this.cooldowns.has(adjustment)) return adjustment
    }
    return undefined
  }

  private decayCooldowns() {
    for (const [adjustment, remaining] of this.cooldowns) {
      if (remaining <= 1) this.cooldowns.delete(adjustment)
      else this.cooldowns.set(adjustment, remaining - 1)
    }
  }

  private applyStrategy(input: ContextStrategyState) {
    const maxTokens = clampInt(input.maxTokens, this.minTokenFloor, this.contextWindowTokens)
    this._strategyState = {
      staticContextStrategy: input.staticContextStrategy,
      maxTokens,
      compactAt: clampNumber(input.compactAt, 0.6, 0.9),
      activeWindowUserTurns: clampInt(input.activeWindowUserTurns, 1, 10),
      toolResultTokenBudget: clampInt(input.toolResultTokenBudget, 300, 4_000),
      dynamicSummaryTokenBudget: clampInt(input.dynamicSummaryTokenBudget, 800, 8_000),
      maxSteps: clampInt(input.maxSteps, minMaxSteps, maxMaxSteps),
    }
    this.state.maxTokens = maxTokens
  }
}

export function estimateTextTokens(text: string) {
  let tokens = 0
  for (const char of text) tokens += isCJK(char) ? 0.6 : 0.3
  return Math.ceil(tokens)
}

const contextExecutionContract = [
  "Context execution contract:",
  "- Treat the current prompt, selected context ledger, summary, and message history as the complete available state unless the user explicitly says otherwise.",
  "- Answer the latest user request directly; do not ask for prior turns that are already represented in summaries, ledgers, fixtures, or placeholders.",
  "- Resolve pronouns, implicit intent, latest overrides, preferences, conflicts, and task progress from the active window plus the context ledger before responding.",
  "- Preserve exact user-supplied entity names, versions, paths, identifiers, and constraints when they are relevant.",
  "- Prefer current ledger records over older summary text when they conflict; history records explain previous decisions but do not override current records.",
  "- Keep dynamic run facts in the ledger or message history, after the stable static prefix, to protect prompt-cache reuse.",
].join("\n")

const currentAlwaysKinds = new Set<LedgerKind>(["intent", "decision", "constraint", "preference", "entity", "failure", "conflict"])
const historyTriggerPattern = /\b(previous|prior|rollback|revert|why|reason|tried|rejected|superseded)\b|之前|以前|回退|为什么|原因|试过|拒绝|废弃|覆盖/i

function renderContextLedger(ledger: StructuredContextLedger | ContextLedger | undefined) {
  const normalized = normalizedLedger(ledger)
  if (!normalized) return ""
  const lines = ["<context_state_ledger>"]
  if (normalized.current.length) {
    lines.push("current:")
    for (const record of normalized.current) lines.push(`- ${formatLedgerRecord(record)}`)
  }
  if (normalized.history.length) {
    lines.push("history:")
    for (const record of normalized.history) lines.push(`- ${formatLedgerRecord(record)}`)
  }
  lines.push("</context_state_ledger>")
  return lines.join("\n")
}

function normalizedLedger(ledger: StructuredContextLedger | ContextLedger | undefined): StructuredContextLedger | undefined {
  if (!ledger) return undefined
  const records: LedgerRecord[] = []
  if (Array.isArray(ledger.current)) records.push(...ledger.current)
  if (Array.isArray(ledger.history)) records.push(...ledger.history)
  if (!records.length) return undefined
  const normalizedRecords = records.map(normalizeLedgerRecord).filter((record): record is LedgerRecord => Boolean(record))
  const current: LedgerRecord[] = []
  const history: LedgerRecord[] = []
  for (const record of normalizedRecords) {
    if (record.status === "current") current.push(record)
    else history.push(record)
  }
  return normalizeStructuredLedger({ current, history })
}

function mergeLedger(current: StructuredContextLedger | undefined, patch: ContextLedger) {
  const base = normalizedLedger(current) ?? emptyLedger()
  const incoming = normalizedLedger(patch) ?? emptyLedger()
  const next = { current: [...base.current], history: [...base.history] }
  for (const record of [...incoming.current, ...incoming.history]) {
    const key = ledgerRecordKey(record)
    const replaced: LedgerRecord[] = []
    next.current = next.current.filter((existing) => {
      if (ledgerRecordKey(existing) !== key) return true
      replaced.push(existing)
      return false
    })
    for (const existing of replaced) {
      const status = record.status === "current" ? "superseded" : record.status
      next.history.push({ ...existing, status, updatedAtTurn: Math.max(existing.updatedAtTurn, record.updatedAtTurn), supersedes: uniqueStrings([...(existing.supersedes ?? []), record.id]) })
    }
    if (record.status === "current") next.current.push({ ...record, supersedes: uniqueStrings([...(record.supersedes ?? []), ...replaced.map((item) => item.id)]) })
    else next.history.push(record)
  }
  return normalizeStructuredLedger(next)
}

function emptyLedger(): StructuredContextLedger {
  return { current: [], history: [] }
}

function normalizeStructuredLedger(ledger: StructuredContextLedger): StructuredContextLedger | undefined {
  const current = dedupeRecords(ledger.current)
  const history = dedupeRecords(ledger.history)
  if (!current.length && !history.length) return undefined
  return { current, history }
}

function dedupeRecords(records: LedgerRecord[]) {
  const seen = new Set<string>()
  const result: LedgerRecord[] = []
  for (const record of records) {
    const key = record.id
    if (seen.has(key)) continue
    seen.add(key)
    result.push(record)
  }
  return result
}

function normalizeLedgerRecord(input: Partial<LedgerRecord> | undefined): LedgerRecord | undefined {
  if (!input?.kind || !input.subject || !input.value) return undefined
  const status = isLedgerStatus(input.status) ? input.status : "current"
  const createdAtTurn = safeTurn(input.createdAtTurn)
  const updatedAtTurn = safeTurn(input.updatedAtTurn ?? createdAtTurn)
  const record: LedgerRecord = {
    id: input.id || stableLedgerID(input.kind, input.subject, input.value, input.scope),
    kind: input.kind,
    subject: compactLedgerText(input.subject),
    value: compactLedgerText(input.value),
    status,
    createdAtTurn,
    updatedAtTurn,
  }
  const scope = normalizeLedgerScope(input.scope)
  if (scope) record.scope = scope
  if (input.reason) record.reason = compactLedgerText(input.reason)
  if (input.evidence) record.evidence = input.evidence
  if (input.supersedes?.length) record.supersedes = uniqueStrings(input.supersedes)
  return record
}

function selectContextLedger(ledger: StructuredContextLedger | ContextLedger | undefined, messages: Message[], tokenBudget: number) {
  const normalized = normalizedLedger(ledger)
  if (!normalized) return undefined
  const signal = ledgerSelectionSignal(messages)
  const includeHistory = historyTriggerPattern.test(signal.text)
  const current = normalized.current.filter((record) => isAlwaysCurrent(record) || recordRelevant(record, signal))
  const currentKeys = new Set(current.map(ledgerRecordKey))
  const history = normalized.history.filter((record) => {
    const related = currentKeys.has(ledgerRecordKey(record)) || recordRelevant(record, signal) || recordMentioned(record, signal)
    if (!related) return false
    if (!includeHistory && !currentKeys.has(ledgerRecordKey(record)) && !recordRelevant(record, signal)) return false
    return record.status === "rejected" || record.status === "superseded" || record.status === "resolved" || recordRelevant(record, signal)
  })
  return fitLedgerToBudget({ current: sortRecords(current), history: sortRecords(history) }, tokenBudget)
}

function fitLedgerToBudget(ledger: StructuredContextLedger, tokenBudget: number) {
  const selected = emptyLedger()
  const ranked = [...ledger.current.map((record) => ({ record, tier: currentRecordTier(record), bucket: "current" as const })), ...ledger.history.map((record) => ({ record, tier: historyRecordTier(record), bucket: "history" as const }))]
    .sort((left, right) => left.tier - right.tier || right.record.updatedAtTurn - left.record.updatedAtTurn)
  for (const item of ranked) {
    const candidate = item.bucket === "current"
      ? { current: [...selected.current, item.record], history: selected.history }
      : { current: selected.current, history: [...selected.history, item.record] }
    if (estimateTextTokens(renderContextLedger(candidate)) > tokenBudget && selected.current.length + selected.history.length > 0) continue
    if (item.bucket === "current") selected.current.push(item.record)
    else selected.history.push(item.record)
  }
  return normalizeStructuredLedger(selected)
}

function currentRecordTier(record: LedgerRecord) {
  if (record.kind === "intent" || record.kind === "constraint") return 0
  if (record.kind === "failure" || record.kind === "conflict") return 1
  if (record.kind === "preference") return 2
  if (record.kind === "file") return 3
  return 4
}

function historyRecordTier(record: LedgerRecord) {
  if (record.status === "rejected" || record.status === "superseded") return 5
  if (record.status === "resolved") return 6
  return 7
}

function isAlwaysCurrent(record: LedgerRecord) {
  return record.status === "current" && currentAlwaysKinds.has(record.kind)
}

function recordRelevant(record: LedgerRecord, signal: LedgerSelectionSignal) {
  const haystack = `${record.subject} ${record.value} ${record.scope?.topics?.join(" ") ?? ""} ${record.scope?.symbols?.join(" ") ?? ""}`.toLowerCase()
  if (signal.keywords.some((keyword) => keyword.length >= 3 && haystack.includes(keyword))) return true
  for (const file of record.scope?.files ?? []) {
    if (signal.files.has(file) || signal.text.includes(file.toLowerCase()) || signal.text.includes(pathBasename(file).toLowerCase())) return true
  }
  return false
}

function recordMentioned(record: LedgerRecord, signal: LedgerSelectionSignal) {
  return ledgerMentionTerms(record).some((term) => term.length >= 2 && signal.text.includes(term))
}

function ledgerMentionTerms(record: LedgerRecord) {
  return uniqueStrings([record.subject, ...record.value.toLowerCase().split(/[:：,，.。()（）\s]+/), ...(record.scope?.topics ?? []), ...(record.scope?.symbols ?? [])].map((item) => item.toLowerCase()))
}

type LedgerSelectionSignal = {
  text: string
  files: Set<string>
  keywords: string[]
}

function ledgerSelectionSignal(messages: Message[]): LedgerSelectionSignal {
  const recent = messages.slice(-8)
  const text = messagesToProviderInput(recent).map((message) => message.content).join("\n").toLowerCase()
  const files = new Set(extractFileRefs(text))
  const keywords = uniqueStrings(text.split(/[^A-Za-z0-9_.\/-]+/).filter((item) => item.length >= 3 && item.length <= 80))
  return { text, files, keywords }
}

function extractFileRefs(text: string) {
  const matches = text.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|css|html|go|py|rs|toml|yaml|yml)/g)
  return uniqueStrings([...matches].map((match) => normalizePathRef(match[0])))
}

function normalizePathRef(input: string) {
  return input.replaceAll("\\", "/").replace(/^\.\//, "")
}

function pathBasename(input: string) {
  const normalized = normalizePathRef(input)
  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

function sortRecords(records: LedgerRecord[]) {
  return [...records].sort((left, right) => currentRecordTier(left) - currentRecordTier(right) || right.updatedAtTurn - left.updatedAtTurn || left.subject.localeCompare(right.subject))
}

function formatLedgerRecord(record: LedgerRecord) {
  const parts = [`[${record.kind}/${record.status}] ${record.subject} = ${record.value}`]
  const scope = formatScope(record.scope)
  if (scope) parts.push(`scope: ${scope}`)
  if (record.reason) parts.push(`reason: ${record.reason}`)
  if (record.evidence) parts.push(`evidence: ${record.evidence.source}${record.evidence.toolCallID ? `:${record.evidence.toolCallID}` : ""}`)
  return parts.join(" | ")
}

function formatScope(scope: LedgerScope | undefined) {
  if (!scope) return ""
  const parts: string[] = []
  if (scope.taskID) parts.push(`task=${scope.taskID}`)
  if (scope.files?.length) parts.push(`files=${scope.files.join(",")}`)
  if (scope.symbols?.length) parts.push(`symbols=${scope.symbols.join(",")}`)
  if (scope.topics?.length) parts.push(`topics=${scope.topics.join(",")}`)
  return parts.join(";")
}

function ledgerRecordKey(record: LedgerRecord) {
  return `${record.kind}:${record.subject}:${scopeKey(record.scope)}`
}

function scopeKey(scope: LedgerScope | undefined) {
  if (!scope) return ""
  return stableStringify({
    taskID: scope.taskID,
    files: [...(scope.files ?? [])].sort(),
    symbols: [...(scope.symbols ?? [])].sort(),
    topics: [...(scope.topics ?? [])].sort(),
  })
}

function normalizeLedgerScope(scope: LedgerScope | undefined) {
  if (!scope) return undefined
  const next: LedgerScope = {}
  if (scope.taskID) next.taskID = compactLedgerText(scope.taskID)
  if (scope.files?.length) next.files = uniqueStrings(scope.files.map(normalizePathRef).filter(Boolean))
  if (scope.symbols?.length) next.symbols = uniqueStrings(scope.symbols.map(compactLedgerText).filter(Boolean))
  if (scope.topics?.length) next.topics = uniqueStrings(scope.topics.map(compactLedgerText).filter(Boolean))
  return Object.keys(next).length ? next : undefined
}

function summaryLedgerConflicts(summary: string, ledger: StructuredContextLedger | undefined, turn: number) {
  const normalized = normalizedLedger(ledger)
  if (!normalized) return []
  const conflicts: LedgerRecord[] = []
  for (const record of normalized.current) {
    const escaped = record.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = summary.match(new RegExp(`${escaped}\\s*:\\s*([^\\n]+)`, "i"))
    if (!match || match[1]?.includes(record.value)) continue
    conflicts.push(normalizeLedgerRecord({
      kind: "conflict",
      subject: `summary_conflict:${record.subject}`,
      value: `summary says "${match[1]?.trim()}", current ledger says "${record.value}"`,
      status: "current",
      reason: "summary conflicts with current structured ledger; current ledger wins",
      evidence: { source: "summary" },
      createdAtTurn: turn,
      updatedAtTurn: turn,
    }) as LedgerRecord)
  }
  return conflicts
}

function validateLedger(ledger: StructuredContextLedger | undefined) {
  if (!ledger) return []
  const issues: string[] = []
  const currentKeys = new Map<string, number>()
  for (const record of ledger.current) currentKeys.set(ledgerRecordKey(record), (currentKeys.get(ledgerRecordKey(record)) ?? 0) + 1)
  for (const [key, count] of currentKeys) if (count > 1) issues.push(`duplicate current record: ${key}`)
  for (const record of ledger.history) {
    if ((record.status === "rejected" || record.status === "superseded") && !record.reason && !record.supersedes?.length) issues.push(`missing reason for ${record.status}: ${record.subject}`)
    if (record.kind === "file" && !record.evidence) issues.push(`file record missing evidence: ${record.subject}`)
  }
  return issues
}

function stableLedgerID(kind: LedgerKind, subject: string, value: string, scope: LedgerScope | undefined) {
  return `ledger_${kind}_${hashText(`${subject}\n${value}\n${scopeKey(scope)}`)}`
}

function hashText(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function isLedgerStatus(value: unknown): value is LedgerStatus {
  return value === "current" || value === "superseded" || value === "rejected" || value === "resolved" || value === "archived"
}

function safeTurn(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function compactLedgerText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function uniqueNonEmpty(items: string[] | undefined) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items ?? []) {
    const trimmed = item.replace(/\s+/g, " ").trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))]
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

function splitRecentUserTurns(messages: Message[], preserveRecentUserTurns: number) {
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

function estimateMessages(messages: Message[]) {
  return estimateTextTokens(messagesToProviderInput(messages).map((message) => message.content).join("\n"))
}

function shouldSendStaticContext(cacheStrategy: CacheStrategy, activeStrategy: StaticContextStrategy, step: number) {
  if (cacheStrategy === "balanced") return step === 0
  if (cacheStrategy === "cache-heavy") return true
  return step === 0 || activeStrategy === "every-step"
}

function sortedSkills(skills: SkillInfo[]) {
  return [...skills].sort((left, right) => left.name.localeCompare(right.name))
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
}

function estimateStaticPrefixTokens(messages: ProviderInputMessage[]) {
  const first = messages[0]
  return first?.role === "system" ? estimateTextTokens(first.content) : 0
}

function emptyWindowStats(): WindowStats {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, maxStepFailures: 0 }
}

function addWindowStats(target: WindowStats, input: WindowStats) {
  target.calls += input.calls
  target.inputTokens += input.inputTokens
  target.outputTokens += input.outputTokens
  target.cacheHitTokens += input.cacheHitTokens
  target.cacheMissTokens += input.cacheMissTokens
  target.maxStepFailures += input.maxStepFailures
}

function cloneWindow(input: WindowStats): WindowStats {
  return { ...input }
}

function cloneStrategy(input: ContextStrategyState): ContextStrategyState {
  return { ...input }
}

function sameStrategy(left: ContextStrategyState, right: ContextStrategyState) {
  return left.staticContextStrategy === right.staticContextStrategy &&
    left.maxTokens === right.maxTokens &&
    left.compactAt === right.compactAt &&
    left.activeWindowUserTurns === right.activeWindowUserTurns &&
    left.toolResultTokenBudget === right.toolResultTokenBudget &&
    left.dynamicSummaryTokenBudget === right.dynamicSummaryTokenBudget &&
    left.maxSteps === right.maxSteps
}

function adjustedStrategy(input: ContextStrategyState, adjustment: AdjustmentName, contextWindowTokens: number): ContextStrategyState {
  const next = cloneStrategy(input)
  if (adjustment === "toolResultTokenBudget") next.toolResultTokenBudget = Math.max(300, Math.floor(next.toolResultTokenBudget * 0.75))
  if (adjustment === "maxTokens") next.maxTokens = Math.min(contextWindowTokens, Math.max(minMaxTokens, Math.ceil(next.maxTokens * 1.25)))
  if (adjustment === "compactAt") next.compactAt = Math.min(0.9, Number((next.compactAt + 0.05).toFixed(2)))
  if (adjustment === "activeWindowUserTurns") next.activeWindowUserTurns = Math.min(10, next.activeWindowUserTurns + 1)
  if (adjustment === "dynamicSummaryTokenBudget") next.dynamicSummaryTokenBudget = Math.max(800, Math.floor(next.dynamicSummaryTokenBudget * 0.75))
  if (adjustment === "maxSteps") next.maxSteps = Math.min(maxMaxSteps, next.maxSteps + 2)
  if (adjustment === "staticContextStrategy") next.staticContextStrategy = "first-step"
  return next
}

function windowMetrics(input: WindowStats, pricing: CachePricing) {
  const cost = effectiveWindowCost(input, pricing)
  return {
    hitRate: input.inputTokens === 0 ? 0 : input.cacheHitTokens / input.inputTokens,
    costPerCall: input.calls === 0 ? 0 : cost / input.calls,
  }
}

function isDegradedWindow(current: ReturnType<typeof windowMetrics>, accepted: ReturnType<typeof windowMetrics>) {
  return current.hitRate < accepted.hitRate - hitRateTolerance && current.costPerCall > accepted.costPerCall * (1 + acceptedCostImprovement)
}

function effectiveWindowCost(input: WindowStats, pricing: CachePricing) {
  return input.cacheMissTokens * pricing.inputCacheMiss + input.cacheHitTokens * pricing.inputCacheHit
}

function truncateToTokenBudget(text: string, tokenBudget: number) {
  if (estimateTextTokens(text) <= tokenBudget) return text
  const charBudget = Math.max(0, Math.floor(tokenBudget / 0.3))
  return `${text.slice(0, charBudget)}\n[truncated summary to ${tokenBudget} estimated tokens]`
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}
