import { canonicalizeHistoryMessage, type Message } from "../message"
import type { ContextLedger, ContextManagerLike } from "../context"
import { emitLog, type Logger } from "../logger"
import { analyzeBashCommand } from "../tool/bash"

type ContextSnapshot = {
  messages: number
  tokenEstimate: number
  hasSummary?: boolean
  latestActualInputTokens?: number
}

function snapshotContext(context: ContextManagerLike): ContextSnapshot {
  return {
    messages: context.state.messages.length,
    tokenEstimate: context.state.tokenEstimate,
    hasSummary: Boolean(context.state.summary),
    latestActualInputTokens: context.state.latestActualInputTokens,
  }
}

function ledgerLogDetail(ledger: ContextManagerLike["state"]["ledger"]) {
  return {
    currentRecords: ledger?.current.length ?? 0,
    historyRecords: ledger?.history.length ?? 0,
  }
}

export class LoggingContextDecorator implements ContextManagerLike {
  constructor(
    private readonly inner: ContextManagerLike,
    private readonly logger: Logger,
  ) {}

  get state() {
    return this.inner.state
  }

  get strategyState() {
    return this.inner.strategyState
  }

  get compactAt() {
    return this.inner.compactAt
  }

  get preserveRecentUserTurns() {
    return this.inner.preserveRecentUserTurns
  }

  get compactPreserveTokens() {
    return this.inner.compactPreserveTokens
  }

  add(message: Message) {
    const canonical = canonicalizeHistoryMessage(message)
    this.logAdd(canonical)
    this.inner.add(canonical)
  }

  setLedger(ledger: ContextLedger | undefined) {
    this.inner.setLedger(ledger)
    emitLog(this.logger, { type: "context", name: "context.ledger_set", detail: { ...ledgerLogDetail(this.inner.state.ledger), inputSections: Object.keys(ledger ?? {}) } })
  }

  updateLedger(patch: ContextLedger) {
    this.inner.updateLedger(patch)
    emitLog(this.logger, { type: "context", name: "context.ledger_update", detail: { ...ledgerLogDetail(this.inner.state.ledger), inputSections: Object.keys(patch) } })
  }

  clearLedger() {
    this.inner.clearLedger()
    emitLog(this.logger, { type: "context", name: "context.ledger_clear", detail: {} })
  }

  estimate(messages: Message[]) {
    return this.inner.estimate(messages)
  }

  configureStrategy(input: Parameters<ContextManagerLike["configureStrategy"]>[0]) {
    this.inner.configureStrategy(input)
    emitLog(this.logger, { type: "context", name: "context.strategy_configure", detail: this.inner.strategyState })
  }

  recordUsage(inputTokens: number) {
    this.inner.recordUsage(inputTokens)
    emitLog(this.logger, { type: "context", name: "context.actual_input_tokens", detail: { inputTokens, estimatedTokens: this.inner.state.tokenEstimate } })
  }

  observeUsage(observation: Parameters<ContextManagerLike["observeUsage"]>[0]) {
    this.inner.observeUsage(observation)
    emitLog(this.logger, { type: "context", name: "context.usage_observed", detail: { observation, strategy: this.inner.strategyState } })
  }

  needsCompaction() {
    return this.inner.needsCompaction()
  }

  compactionInput() {
    const input = this.inner.compactionInput()
    emitLog(this.logger, { type: "context", name: "context.compaction_input", detail: { providerMessageCount: input.length } })
    return input
  }

  compactionSnapshot() {
    const snapshot = this.inner.compactionSnapshot()
    emitLog(this.logger, { type: "context", name: "context.compaction_snapshot", detail: { providerMessageCount: snapshot?.providerMessages.length ?? 0, compactedMessageCount: snapshot?.compactedMessageCount ?? 0 } })
    return snapshot
  }

  compact(summary: string) {
    const before = snapshotContext(this.inner)
    const compacted = this.inner.compact(summary)
    emitLog(this.logger, { type: "context", name: "context.compact", detail: { compacted, before, after: snapshotContext(this.inner) } })
    return compacted
  }

  compactSnapshot(summary: string, snapshot: Parameters<ContextManagerLike["compactSnapshot"]>[1]) {
    const before = snapshotContext(this.inner)
    const compacted = this.inner.compactSnapshot(summary, snapshot)
    emitLog(this.logger, { type: "context", name: "context.compact_snapshot", detail: { compacted, before, after: snapshotContext(this.inner), compactedMessageCount: snapshot.compactedMessageCount } })
    return compacted
  }

  planRequest(input: Parameters<ContextManagerLike["planRequest"]>[0]) {
    const plan = this.inner.planRequest(input)
    emitLog(this.logger, { type: "data", name: "context -> provider", detail: { messageCount: this.inner.state.messages.length, providerMessageCount: plan.providerMessages.length, toolNames: input.tools.map((tool) => tool.name), staticContext: plan.providerMessages[0]?.role === "system", strategy: plan.strategyState, ledger: plan.ledgerStats } })
    return plan
  }

  compose(input?: Parameters<ContextManagerLike["compose"]>[0]) {
    const providerMessages = this.inner.compose(input)
    emitLog(this.logger, { type: "data", name: "context -> provider", detail: { messageCount: this.inner.state.messages.length, providerMessageCount: providerMessages.length, toolNames: input?.tools.map((tool) => tool.name) ?? [], staticContext: Boolean(input) } })
    return providerMessages
  }

  selectedLedgerText() {
    const text = this.inner.selectedLedgerText()
    emitLog(this.logger, { type: "data", name: "context ledger -> tool", detail: { textLength: text.length } })
    return text
  }

  private logAdd(message: Message) {
    for (const part of message.parts) {
      if (message.role === "user" && part.type === "text") emitLog(this.logger, { type: "data", name: "user_input -> context", detail: { promptLength: part.text.length } })
      if (message.role === "assistant" && part.type === "text") emitLog(this.logger, { type: "data", name: "provider -> assistant_message", detail: { textLength: part.text.length } })
      if (message.role === "assistant" && part.type === "tool_call") {
        emitLog(this.logger, {
          type: "data",
          name: "provider -> tool_call_message",
          detail: { tool: part.call.name, callID: part.call.id, ...bashToolCallDetail(part.call.name, part.call.input) },
        })
      }
      if (message.role === "tool" && part.type === "tool_result") {
        emitLog(this.logger, {
          type: "data",
          name: "tool_result -> context",
          detail: { tool: part.toolName, callID: part.callID, status: part.status, outputLength: part.output.length, ...bashToolResultDetail(part.toolName, part.metadata) },
        })
      }
    }
  }
}

function bashToolCallDetail(toolName: string, input: unknown) {
  if (toolName !== "bash" || typeof input !== "object" || input === null) return {}
  const record = input as Record<string, unknown>
  const command = typeof record.command === "string" ? record.command : undefined
  if (!command) return {}
  const analysis = analyzeBashCommand(command)
  return {
    command,
    normalizedCommand: analysis.normalizedCommand,
    commandClass: analysis.commandClass,
    replaceableBy: analysis.replaceableBy,
  }
}

function bashToolResultDetail(toolName: string, metadata: Record<string, unknown>) {
  if (toolName !== "bash") return {}
  return {
    command: stringMetadata(metadata.command),
    normalizedCommand: stringMetadata(metadata.normalizedCommand),
    commandClass: stringMetadata(metadata.commandClass),
    replaceableBy: stringArrayMetadata(metadata.replaceableBy),
  }
}

function stringMetadata(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function stringArrayMetadata(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}
