import type { AgentRunState } from "./agent"
import type { Message, ProviderInputMessage } from "./message"
import { ProviderError, type Provider, type ProviderEvent } from "./provider"
import type { SkillServiceLike } from "./skill"
import { estimateTextTokens, type ContextLedger, type ContextManagerLike } from "./context"
import type { ToolRegistryLike } from "./tool"
import { emitLog, type Logger } from "./logger"

type ContextSnapshot = {
  messages: number
  tokenEstimate: number
  hasSummary?: boolean
  latestActualInputTokens?: number
}

export interface RunAspect {
  instrumentContext(context: ContextManagerLike): ContextManagerLike
  instrumentSkills(skills: SkillServiceLike): SkillServiceLike
  instrumentProvider(provider: Provider): Provider
  instrumentRegistry(registry: ToolRegistryLike): ToolRegistryLike
  transition(to: AgentRunState, detail?: Record<string, unknown>): AgentRunState
  step(step: number, maxSteps: number): void
  runFailed(reason: string, usedTools: string[]): AgentRunState
}

export class NoopRunAspect implements RunAspect {
  private state: AgentRunState = "idle"

  instrumentContext(context: ContextManagerLike) {
    return context
  }

  instrumentSkills(skills: SkillServiceLike) {
    return skills
  }

  instrumentProvider(provider: Provider) {
    return provider
  }

  instrumentRegistry(registry: ToolRegistryLike) {
    return registry
  }

  transition(to: AgentRunState) {
    this.state = to
    return this.state
  }

  step() {}

  runFailed() {
    return this.transition("failed")
  }
}

export class LoggingRunAspect implements RunAspect {
  private state: AgentRunState = "idle"

  constructor(private readonly logger: Logger) {}

  instrumentContext(context: ContextManagerLike): ContextManagerLike {
    return new LoggingContextDecorator(context, this.logger)
  }

  instrumentSkills(skills: SkillServiceLike): SkillServiceLike {
    const logger = this.logger
    return {
      available: async () => {
        const available = await skills.available()
        emitLog(logger, { type: "data", name: "skills -> context", detail: { skillCount: available.length } })
        return available
      },
      load: (name) => skills.load(name),
    }
  }

  instrumentProvider(provider: Provider): Provider {
    const logger = this.logger
    return {
      name: provider.name,
      model: provider.model,
      capabilities: provider.capabilities,
      async *stream(input) {
        let totalLength = 0
        let reasoningContent = ""
        let output = ""
        let usage: ProviderUsageLog | undefined
        const toolCalls: Array<{ tool: string; callID: string }> = []
        const summaryRequest = input.prompt.includes("Summarize conversation")
        const inputText = renderProviderInput(input.providerMessages)
        emitLog(logger, { type: "provider", name: "provider.input_tokens", detail: providerInputTokenEstimate(input.providerMessages, input.tools) })
        emitLog(logger, {
          type: "provider",
          name: "provider.input",
          detail: {
            provider: provider.name,
            model: provider.model,
            mode: input.mode,
            prompt: input.prompt,
            tools: input.tools.map((tool) => tool.name),
            input: inputText,
            messages: input.providerMessages.map((message) => ({ role: message.role, content: message.content })),
          },
        })
        if (summaryRequest) emitLog(logger, { type: "provider", name: "provider.summary_request", detail: { prompt: input.prompt, content: input.providerMessages[0]?.content ?? "" } })
        try {
          for await (const event of provider.stream(input)) {
            if (event.type === "usage") usage = providerUsageLog(event)
            logProviderEvent(logger, event, inputText)
            if (event.type === "reasoning_delta") {
              reasoningContent += event.text
            }
            if (event.type === "text_delta") {
              output += event.text
              totalLength += event.text.length
            }
            if (event.type === "failure") {
              output += event.error.output
              totalLength += event.error.output.length
            }
            if (event.type === "tool_call") toolCalls.push({ tool: event.call.name, callID: event.call.id })
            yield event
          }
          emitLog(logger, { type: "provider", name: "provider.output", detail: { provider: provider.name, reasoningContent, textLength: output.length, output, toolCalls } })
          emitProviderTranscript(logger, { provider: provider.name, model: provider.model, prompt: input.prompt, input: inputText, output, reasoningContent, toolCalls, usage })
          if (summaryRequest) emitLog(logger, { type: "provider", name: "provider.summary_output", detail: { summary: output } })
        } catch (error) {
          if (error instanceof ProviderError && error.output) emitLog(logger, { type: "provider", name: "provider.output", detail: { provider: provider.name, reasoningContent, textLength: error.output.length, output: error.output, toolCalls } })
          emitProviderTranscript(logger, { provider: provider.name, model: provider.model, prompt: input.prompt, input: inputText, output, reasoningContent, toolCalls, usage, error: providerErrorDetail(provider.name, error) })
          emitLog(logger, { type: "error", name: "provider.error", detail: providerErrorDetail(provider.name, error) })
          throw error
        }
      },
    }
  }

  instrumentRegistry(registry: ToolRegistryLike): ToolRegistryLike {
    const logger = this.logger
    return {
      list: (mode) => registry.list(mode),
      get: (name) => registry.get(name),
      run: async (name, input, ctx) => {
        emitLog(logger, { type: "tool", name: "tool.lookup", detail: { tool: name } })
        const tool = registry.get(name)
        let permissionEvaluationLogged = false
        if (!tool) emitLog(logger, { type: "tool", name: "tool.missing", detail: { tool: name } })
        if (tool && !tool.modes.includes(ctx.agentMode)) emitLog(logger, { type: "tool", name: "tool.disabled", detail: { tool: name, mode: ctx.agentMode } })
        if (tool) {
          try {
            emitLog(logger, { type: "tool", name: "tool.validate.start", detail: { tool: name } })
            const parsed = tool.inputSchema.safeParse(input)
            if (parsed.success) {
              emitLog(logger, { type: "tool", name: "tool.validate.succeeded", detail: { tool: name } })
              const patterns = tool.patterns(parsed.data, ctx)
              permissionEvaluationLogged = true
              emitLog(logger, { type: "tool", name: "permission.evaluate", detail: { tool: name, permission: tool.permission, patterns } })
              if (patterns.some((pattern) => ctx.permission.evaluate(tool.permission, pattern) === "ask")) {
                emitLog(logger, { type: "tool", name: "permission.waiting", detail: { tool: name, permission: tool.permission, patterns } })
              }
            } else {
              emitLog(logger, { type: "tool", name: "tool.validate.failed", detail: { tool: name, issues: parsed.error.issues } })
            }
          } catch (error) {
            emitLog(logger, { type: "tool", name: "tool.inspect.failed", detail: { tool: name, error: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error) } })
          }
        }
        try {
          const result = await registry.run(name, input, ctx)
          if (tool && permissionEvaluationLogged && result.metadata.status !== "denied") emitLog(logger, { type: "tool", name: "permission.allowed", detail: { tool: name, permission: tool.permission } })
          emitLog(logger, { type: "tool", name: "tool.execute.done", detail: { tool: name, status: result.metadata.status, outputLength: result.output.length } })
          return result
        } catch (error) {
          emitLog(logger, { type: "error", name: "tool.failed", detail: { tool: name, error: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error) } })
          throw error
        }
      },
    }
  }

  transition(to: AgentRunState, detail?: Record<string, unknown>) {
    emitLog(this.logger, { type: "state", name: "agent.state", detail: { from: this.state, to, ...detail } })
    this.state = to
    return this.state
  }

  step(step: number, maxSteps: number) {
    emitLog(this.logger, { type: "state", name: "agent.step", detail: { step, maxSteps } })
  }

  runFailed(reason: string, usedTools: string[]) {
    return this.transition("failed", { reason, usedTools })
  }
}

function providerInputTokenEstimate(providerMessages: Array<{ content: string }>, tools: unknown[]) {
  const messageTokens = estimateTextTokens(providerMessages.map((message) => message.content).join(""))
  const toolTokens = estimateTextTokens(tools.length > 0 ? JSON.stringify(tools) : "")
  return {
    tokenEstimate: messageTokens + toolTokens,
    messageTokens,
    toolTokens,
    providerMessageCount: providerMessages.length,
    toolCount: tools.length,
  }
}

type ProviderUsageLog = {
  inputTokens: number
  outputTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheHit: boolean
}

function providerUsageLog(event: Extract<ProviderEvent, { type: "usage" }>): ProviderUsageLog {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheHitTokens: event.cacheHitTokens,
    cacheMissTokens: event.cacheMissTokens,
    totalTokens: event.totalTokens,
    reasoningTokens: event.reasoningTokens,
    cacheHit: (event.cacheHitTokens ?? 0) > 0,
  }
}

function logProviderEvent(logger: Logger, event: ProviderEvent, inputText = "") {
  if (event.type === "response" && !event.response.ok) emitLog(logger, { type: "provider", name: "provider.response", detail: { body: event.response.body ?? "" } })
  if (event.type === "response_raw" && rawProviderResponseHasError(event.response)) emitLog(logger, { type: "provider", name: "provider.response.raw", detail: { response: event.response } })
  if (event.type === "failure") {
    emitLog(logger, { type: "provider", name: "provider.failure", detail: event.error })
    emitLog(logger, { type: "error", name: "provider.error", detail: event.error })
  }
  if (event.type === "tool_call") emitLog(logger, { type: "provider", name: "provider.tool_call", detail: { tool: event.call.name, callID: event.call.id } })
  if (event.type === "usage") {
    const usage = providerUsageLog(event)
    const cached = cachedInputMark(inputText, usage.cacheHitTokens)
    emitLog(logger, {
      type: "provider",
      name: "provider.usage",
      detail: {
        ...usage,
        cachedInput: cached.cachedInput,
        uncachedInput: cached.uncachedInput,
        markedInput: cached.markedInput,
      },
    })
  }
  if (event.type === "done") emitLog(logger, { type: "provider", name: "provider.done" })
}

function emitProviderTranscript(logger: Logger, input: {
  provider: string
  model?: string
  prompt: string
  input: string
  output: string
  reasoningContent: string
  toolCalls: Array<{ tool: string; callID: string }>
  usage?: ProviderUsageLog
  error?: Record<string, unknown>
}) {
  const cached = cachedInputMark(input.input, input.usage?.cacheHitTokens)
  emitLog(logger, {
    type: "provider",
    name: "provider.transcript",
    detail: {
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      input: input.input,
      output: input.output,
      reasoningContent: input.reasoningContent,
      toolCalls: input.toolCalls,
      usage: input.usage,
      cacheHit: input.usage?.cacheHit ?? false,
      cachedInput: cached.cachedInput,
      uncachedInput: cached.uncachedInput,
      markedInput: cached.markedInput,
      ...(input.error ? { error: input.error } : {}),
    },
  })
}

function renderProviderInput(messages: ProviderInputMessage[]) {
  return messages.map((message, index) => `<message index="${index}" role="${message.role}">\n${message.content}\n</message>`).join("\n\n")
}

function cachedInputMark(input: string, cacheHitTokens = 0) {
  if (cacheHitTokens <= 0) {
    return {
      cacheHit: false,
      cachedInput: "",
      uncachedInput: input,
      markedInput: `<cache_miss_input>\n${input}\n</cache_miss_input>`,
    }
  }
  const splitIndex = cachedPrefixIndex(input, cacheHitTokens)
  const cachedInput = input.slice(0, splitIndex)
  const uncachedInput = input.slice(splitIndex)
  return {
    cacheHit: true,
    cachedInput,
    uncachedInput,
    markedInput: `<cached_input cache_hit="true" tokens="${cacheHitTokens}">\n${cachedInput}\n</cached_input>\n<cache_miss_input>\n${uncachedInput}\n</cache_miss_input>`,
  }
}

function cachedPrefixIndex(input: string, cacheHitTokens: number) {
  let tokens = 0
  let index = 0
  for (const char of input) {
    tokens += estimatedCharTokens(char)
    index += char.length
    if (Math.ceil(tokens) >= cacheHitTokens) return index
  }
  return input.length
}

function estimatedCharTokens(char: string) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char) ? 0.6 : 0.3
}

function rawProviderResponseHasError(response: unknown) {
  if (!response || typeof response !== "object") return false
  const record = response as { type?: unknown; error?: unknown; response?: unknown }
  if (record.type === "error" || record.type === "response.failed") return true
  if (record.error) return true
  if (record.response && typeof record.response === "object" && (record.response as { error?: unknown }).error) return true
  return false
}

function providerErrorDetail(provider: string, error: unknown) {
  if (error instanceof ProviderError) {
    return {
      provider,
      error: error.name,
      status: error.status,
      message: error.message,
      output: error.output,
    }
  }
  return {
    provider,
    error: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  }
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

class LoggingContextDecorator implements ContextManagerLike {
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
    this.logAdd(message)
    this.inner.add(message)
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
      if (message.role === "assistant" && part.type === "tool_call") emitLog(this.logger, { type: "data", name: "provider -> tool_call_message", detail: { tool: part.call.name, callID: part.call.id } })
      if (message.role === "tool" && part.type === "tool_result") emitLog(this.logger, { type: "data", name: "tool_result -> context", detail: { tool: part.toolName, callID: part.callID, status: part.status, outputLength: part.output.length } })
    }
  }
}

export function createRunAspect(logger?: Logger): RunAspect {
  return logger ? new LoggingRunAspect(logger) : new NoopRunAspect()
}
