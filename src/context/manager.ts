import { defaultCachePricing, type CachePricing } from "../cache-policy"
import type { InstructionInfo } from "../instruction"
import { createMessage, messagesToProviderInput, redactProtectedMessages, summaryPart, textMessage, validProviderMessageSuffix, type Message, type ProviderInputMessage } from "../message"
import type { Agent } from "../agent"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"
import { clampInt, clampNumber } from "../utils/math"
import { mergeLedger, normalizedLedger, renderContextLedger, selectContextLedger, summaryLedgerConflicts, validateLedger } from "./ledger"
import { estimateSummaryTokens, estimateTextTokens, recentProviderMessageSuffix, splitRecentUserTurns } from "./tokens"
import type { ContextBudgetStats, ContextCacheStats, ContextCompactionSnapshot, ContextLedger, ContextLedgerStats, ContextManagerLike, ContextOptions, ContextPlan, ContextPlanInput, ContextState, ContextStrategyState, ContextUsageObservation } from "./types"

type WindowStats = {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

const defaultMaxTokens = 32_000
const defaultMaxSteps = 66
const minMaxTokens = 16_000
const defaultSafetyMultiplier = 1.6
const minSafetyMultiplier = 1
const maxSafetyMultiplier = 4

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
    this.minTokenFloor = options.maxTokens !== undefined && options.maxTokens < minMaxTokens ? Math.max(1, Math.round(options.maxTokens)) : minMaxTokens
    const maxTokens = clampInt(options.maxTokens ?? defaultMaxTokens, this.minTokenFloor, options.contextWindowTokens ?? Number.MAX_SAFE_INTEGER)
    this.contextWindowTokens = options.contextWindowTokens ?? maxTokens
    this.responseReserveTokens = options.responseReserveTokens ?? Math.max(2_000, Math.min(8_000, Math.floor(maxTokens * 0.2)))
    this.pricing = options.pricing ?? defaultCachePricing()
    this.compactPreserveTokens = options.compactPreserveTokens ?? 1_000
    this.safetyMultiplier = clampNumber(options.tokenEstimateSafetyMultiplier ?? defaultSafetyMultiplier, minSafetyMultiplier, maxSafetyMultiplier)
    this._strategyState = {
      maxTokens,
      compactAt: clampNumber(options.compactAt ?? 0.75, 0.6, 0.9),
      activeWindowUserTurns: clampInt(options.activeWindowUserTurns ?? options.preserveRecentUserTurns ?? 3, 1, 10),
      toolResultTokenBudget: clampInt(options.toolResultTokenBudget ?? 1_200, 300, 4_000),
      dynamicSummaryTokenBudget: clampInt(options.dynamicSummaryTokenBudget ?? 3_000, 800, 8_000),
      maxSteps: options.maxSteps ?? defaultMaxSteps,
    }
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
    const { compacted } = splitRecentUserTurns(this.state.messages, this.preserveRecentUserTurns)
    const messages: Message[] = []
    const ledger = renderContextLedger(this.state.ledger)
    if (ledger) messages.push(textMessage("system", ledger))
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(`Previous summary:\n${this.state.summary}`)]))
    messages.push(...redactProtectedMessages(compacted))
    return {
      providerMessages: messagesToProviderInput(messages, { redactProtectedToolResults: true }),
      compactedMessageCount: compacted.length,
      messageCount: this.state.messages.length,
      previousSummary: this.state.summary,
    }
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

  compactSnapshot(summary: string, snapshot: ContextCompactionSnapshot) {
    if (snapshot.compactedMessageCount < 0) return false
    if (this.state.messages.length < snapshot.messageCount) return false
    if (this.state.summary !== snapshot.previousSummary) return false
    const preserved = recentProviderMessageSuffix(this.state.messages.slice(snapshot.compactedMessageCount), this.compactPreserveTokens)
    const nextSummary = truncateToTokenBudget(summary, this._strategyState.dynamicSummaryTokenBudget)
    const conflicts = summaryLedgerConflicts(nextSummary, this.state.ledger, this.state.messages.length)
    if (conflicts.length) this.state.ledger = mergeLedger(this.state.ledger, { current: conflicts })
    this.state.summary = nextSummary
    this.state.messages = preserved
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
    const messages: Message[] = []
    if (input) {
      messages.push(textMessage("system", buildSystemPrompt(input.agent)))
      const instructionPrompt = buildInstructionPrompt(input.instructions ?? [])
      if (instructionPrompt) messages.push(textMessage("system", instructionPrompt))
      const skillPrompt = buildSkillPrompt(input.skills, input.selectedSkills ?? [], input.pendingSkillLoads ?? [])
      if (skillPrompt) messages.push(textMessage("system", skillPrompt))
    }
    if (this.state.summary) messages.push(createMessage("system", [summaryPart(this.state.summary)]))
    const dynamicMessages = this.state.summary ? validProviderMessageSuffix(this.state.messages) : this.state.messages
    messages.push(...dynamicMessages)
    return messagesToProviderInput(messages, { largeOutputLimit: this.largeOutputLimit() })
  }

  selectedLedgerText() {
    return this.renderSelectedLedger()
  }

  private recalculateTokenEstimate() {
    const messageProviderInput = messagesToProviderInput(this.state.messages, { largeOutputLimit: this.largeOutputLimit() })
    const messageTokens = estimateTextTokens(messageProviderInput.map((message) => message.content).join("\n"))
    this.state.tokenEstimate = messageTokens + estimateSummaryTokens(this.state.summary)
  }

  private largeOutputLimit() {
    return Math.ceil(this._strategyState.toolResultTokenBudget / 0.3)
  }

  private maxStaticPrefixTokens = 0

  private cacheStats(currentStaticPrefixTokens: number): ContextCacheStats {
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
      currentStaticPrefixTokens,
      maxStaticPrefixTokens: this.maxStaticPrefixTokens,
      staticPrefixTokens: currentStaticPrefixTokens,
    }
  }

  private budgetStats(): ContextBudgetStats {
    const stats = this.ledgerStats()
    return {
      tokenEstimate: this.state.tokenEstimate,
      compactionBasis: this.compactionBasis(),
      staticPrefixTokens: this.lastStaticPrefixTokens,
      safetyMultiplier: this.safetyMultiplier,
      maxTokens: this.state.maxTokens,
      compactAt: this.compactAt,
      responseReserveTokens: this.responseReserveTokens,
      availableInputTokens: Math.max(0, this.state.maxTokens - this.responseReserveTokens),
      ledgerTokens: stats.tokenEstimate,
      selectedLedgerRecords: stats.selectedRecords,
      ledgerConflicts: stats.validationIssues,
    }
  }

  private compactionBasis() {
    const inflatedEstimate = Math.ceil(this.state.tokenEstimate * this.safetyMultiplier) + this.lastStaticPrefixTokens
    const actual = this.state.latestActualInputTokens ?? 0
    return Math.max(inflatedEstimate, actual)
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

  private applyStrategy(input: ContextStrategyState) {
    const maxTokens = clampInt(input.maxTokens, this.minTokenFloor, this.contextWindowTokens)
    this._strategyState = {
      maxTokens,
      compactAt: clampNumber(input.compactAt, 0.6, 0.9),
      activeWindowUserTurns: clampInt(input.activeWindowUserTurns, 1, 10),
      toolResultTokenBudget: clampInt(input.toolResultTokenBudget, 300, 4_000),
      dynamicSummaryTokenBudget: clampInt(input.dynamicSummaryTokenBudget, 800, 8_000),
      maxSteps: input.maxSteps,
    }
    this.state.maxTokens = maxTokens
  }
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


function sortedSkills(skills: SkillInfo[]) {
  return [...skills].sort((left, right) => left.name.localeCompare(right.name))
}

function buildSystemPrompt(agent: Agent) {
  return [agent.systemPrompt, contextExecutionContract, `Mode: ${agent.mode}`, toolPriorityDirective].join("\n\n")
}

function buildInstructionPrompt(instructions: InstructionInfo[]) {
  if (instructions.length === 0) return ""
  return [
    "Repository and user instruction files. Follow these durable instructions unless they conflict with higher-priority system/developer instructions or the latest user request.",
    ...instructions.map(formatInstruction),
  ].join("\n\n")
}

function formatInstruction(instruction: InstructionInfo) {
  return `<instruction source="${instruction.source}" path="${instruction.path}">\n${instruction.content}\n</instruction>`
}

function buildSkillPrompt(skills: SkillInfo[], selectedSkills: SkillInfo[], pendingSkillLoads: SkillInfo[]) {
  if (skills.length === 0 && selectedSkills.length === 0) return ""
  const skillList = sortedSkills(skills).map(formatSkillDescription).join("\n") || "(none)"
  const selected = sortedSkills(selectedSkills).map(formatSkillDescription).join("\n") || "(none)"
  const selectedSkillList = `Active skills, descriptions only. Load full instructions with the skill tool when needed:\n${selected}`
  const pending = sortedSkills(pendingSkillLoads).map(formatSkillDescription).join("\n")
  const pendingPrompt = pending
    ? `First-use skill load required. Before answering or taking task-specific action, you MUST call the skill tool for each listed skill, then follow the returned instructions:\n${pending}`
    : ""
  return [`Available skills, descriptions only until skill tool is called:\n${skillList}`, `Selected skill instructions:\n${selectedSkillList}`, pendingPrompt].filter(Boolean).join("\n\n")
}

function formatSkillDescription(skill: SkillInfo) {
  return `- ${skill.name}: ${skill.description}`
}

// Keep exploration policy in the stable system prefix so every provider turn
// gets the same tool-ordering contract without duplicating schemas.
const toolPriorityDirective = [
  "Code exploration order:",
  "1. repo_map with query.",
  "2. find_definition / find_references / rg_search.",
  "3. call_graph for bounded callers/callees.",
  "4. read_lines for exact ranges.",
  "5. list / git_diff / read / grep / edit|write / bash.",
  "Do not full-read files over 100 lines. Never read or expose .easycode/cache/code-index/index.json.",
].join("\n")

function staticPrefixMessageCount(input: ContextPlanInput) {
  return 1 + ((input.instructions?.length ?? 0) > 0 ? 1 : 0) + (hasSkillPrompt(input.skills, input.selectedSkills ?? []) ? 1 : 0)
}

function hasSkillPrompt(skills: SkillInfo[], selectedSkills: SkillInfo[]) {
  return skills.length > 0 || selectedSkills.length > 0
}

function estimateStaticPrefixTokens(messages: ProviderInputMessage[], count: number) {
  return estimateTextTokens(messages.slice(0, count).map((message) => message.content).join("\n"))
}

function emptyWindowStats(): WindowStats {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
}

function addWindowStats(target: WindowStats, input: WindowStats) {
  target.calls += input.calls
  target.inputTokens += input.inputTokens
  target.outputTokens += input.outputTokens
  target.cacheHitTokens += input.cacheHitTokens
  target.cacheMissTokens += input.cacheMissTokens
}

function cloneStrategy(input: ContextStrategyState): ContextStrategyState {
  return { ...input }
}

function effectiveWindowCost(input: WindowStats, pricing: CachePricing) {
  return input.cacheMissTokens * pricing.inputCacheMiss + input.cacheHitTokens * pricing.inputCacheHit
}

function truncateToTokenBudget(text: string, tokenBudget: number) {
  if (estimateTextTokens(text) <= tokenBudget) return text
  const charBudget = Math.max(0, Math.floor(tokenBudget / 0.3))
  return `${text.slice(0, charBudget)}\n[truncated summary to ${tokenBudget} estimated tokens]`
}
