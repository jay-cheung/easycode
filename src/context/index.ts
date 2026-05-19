import type { Agent } from "../agent"
import { defaultCachePricing, type CachePricing, type CacheStrategy, type StaticContextStrategy } from "../cache-policy"
import { createMessage, messagesToProviderInput, redactProtectedMessages, summaryPart, textMessage, validProviderMessageSuffix, type Message, type ProviderInputMessage } from "../message"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"

export type ContextState = {
  messages: Message[]
  summary?: string
  ledger?: ContextLedger
  tokenEstimate: number
  maxTokens: number
  latestActualInputTokens?: number
}

export type ContextLedger = {
  rules?: string[]
  facts?: string[]
  preferences?: string[]
  entities?: string[]
  conflicts?: string[]
  taskState?: string[]
  anchors?: string[]
  outputPolicy?: string[]
}

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
    this.state.summary = truncateToTokenBudget(summary, this._strategyState.dynamicSummaryTokenBudget)
    this.state.messages = preserved
    this.recalculateTokenEstimate()
    return true
  }

  planRequest(input: ContextPlanInput): ContextPlan {
    this.lastCacheStrategy = input.cacheStrategy
    const staticInput = shouldSendStaticContext(input.cacheStrategy, this._strategyState.staticContextStrategy, input.step) ? input : undefined
    const providerMessages = this.compose(staticInput)
    const staticPrefixTokens = staticInput ? estimateStaticPrefixTokens(providerMessages) : 0
    this.staticPrefixTokens = Math.max(this.staticPrefixTokens, staticPrefixTokens)
    return {
      providerMessages,
      strategyState: this.strategyState,
      cacheStats: this.cacheStats(),
      budgetStats: this.budgetStats(),
      acceptedStrategyRevision: this.acceptedStrategyRevision,
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
    const ledger = renderContextLedger(this.state.ledger)
    if (ledger) messages.push(textMessage("system", ledger))
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(this.state.summary)]))
    messages.push(...this.state.messages)
    return messagesToProviderInput(messages, { largeOutputLimit: Math.ceil(this._strategyState.toolResultTokenBudget / 0.3) })
  }

  private recalculateTokenEstimate() {
    this.state.tokenEstimate = this.estimate(this.state.messages) + estimateSummaryTokens(this.state.summary) + estimateTextTokens(renderContextLedger(this.state.ledger))
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
    return {
      tokenEstimate: this.state.tokenEstimate,
      maxTokens: this.state.maxTokens,
      compactAt: this.compactAt,
      responseReserveTokens: this.responseReserveTokens,
      availableInputTokens: Math.max(0, this.state.maxTokens - this.responseReserveTokens),
    }
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
  "- Treat the current prompt, context ledger, summary, and message history as the complete available state unless the user explicitly says otherwise.",
  "- Answer the latest user request directly; do not ask for prior turns that are already represented in summaries, ledgers, fixtures, or placeholders.",
  "- Resolve pronouns, implicit intent, latest overrides, preferences, conflicts, and task progress from the active window plus the context ledger before responding.",
  "- Preserve exact user-supplied entity names, versions, paths, identifiers, and constraints when they are relevant.",
  "- Keep dynamic run facts in the ledger or message history, after the stable static prefix, to protect prompt-cache reuse.",
].join("\n")

const ledgerSectionOrder: Array<keyof ContextLedger> = ["rules", "facts", "preferences", "entities", "conflicts", "taskState", "anchors", "outputPolicy"]

function renderContextLedger(ledger: ContextLedger | undefined) {
  const normalized = normalizedLedger(ledger)
  if (!normalized) return ""
  const lines = ["<context_state_ledger>"]
  for (const section of ledgerSectionOrder) {
    const items = normalized[section]
    if (!items?.length) continue
    lines.push(`${section}:`)
    for (const item of items) lines.push(`- ${item}`)
  }
  lines.push("</context_state_ledger>")
  return lines.join("\n")
}

function normalizedLedger(ledger: ContextLedger | undefined) {
  if (!ledger) return undefined
  const normalized: ContextLedger = {}
  for (const section of ledgerSectionOrder) {
    const items = uniqueNonEmpty(ledger[section])
    if (items.length) normalized[section] = items
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function mergeLedger(current: ContextLedger | undefined, patch: ContextLedger) {
  const next: ContextLedger = { ...(current ?? {}) }
  for (const section of ledgerSectionOrder) next[section] = [...(next[section] ?? []), ...(patch[section] ?? [])]
  return next
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
    if (candidate.length === 0) continue
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
