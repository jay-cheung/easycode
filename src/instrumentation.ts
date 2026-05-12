import type { AgentRunState } from "./agent"
import type { Message, ToolCall } from "./message"
import { ProviderError, type Provider, type ProviderEvent } from "./provider"
import type { SkillServiceLike } from "./skill"
import type { ContextManagerLike } from "./context"
import type { ToolRegistryLike, ToolResult } from "./tool"
import { emitLog, type Logger } from "./logger"

type ContextSnapshot = {
  messages: number
  tokenEstimate: number
  hasSummary?: boolean
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
      async *stream(input) {
        let totalLength = 0
        let reasoningContent = ""
        let output = ""
        const toolCalls: Array<{ tool: string; callID: string }> = []
        const summaryRequest = input.prompt.includes("Summarize conversation")
        emitLog(logger, { type: "provider", name: "provider.input_tokens", detail: providerInputTokenEstimate(input.providerMessages, input.tools) })
        if (summaryRequest) emitLog(logger, { type: "provider", name: "provider.summary_request", detail: { prompt: input.prompt, content: input.providerMessages[0]?.content ?? "" } })
        try {
          for await (const event of provider.stream(input)) {
            logProviderEvent(logger, event, totalLength)
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
          if (summaryRequest) emitLog(logger, { type: "provider", name: "provider.summary_output", detail: { summary: output } })
        } catch (error) {
          if (error instanceof ProviderError && error.output) emitLog(logger, { type: "provider", name: "provider.output", detail: { provider: provider.name, reasoningContent, textLength: error.output.length, output: error.output, toolCalls } })
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
  const messageChars = providerMessages.reduce((sum, message) => sum + message.content.length, 0)
  const toolChars = tools.length > 0 ? JSON.stringify(tools).length : 0
  const messageTokens = Math.ceil(messageChars / 4)
  const toolTokens = Math.ceil(toolChars / 4)
  return {
    tokenEstimate: messageTokens + toolTokens,
    messageTokens,
    toolTokens,
    providerMessageCount: providerMessages.length,
    toolCount: tools.length,
  }
}

function logProviderEvent(logger: Logger, event: ProviderEvent, totalLengthBefore: number) {
  if (event.type === "response" && !event.response.ok) emitLog(logger, { type: "provider", name: "provider.response", detail: { body: event.response.body ?? "" } })
  if (event.type === "response_raw" && rawProviderResponseHasError(event.response)) emitLog(logger, { type: "provider", name: "provider.response.raw", detail: { response: event.response } })
  if (event.type === "failure") {
    emitLog(logger, { type: "provider", name: "provider.failure", detail: event.error })
    emitLog(logger, { type: "error", name: "provider.error", detail: event.error })
  }
  if (event.type === "reasoning_delta") emitLog(logger, { type: "provider", name: "provider.reasoning_delta", detail: { length: event.text.length } })
  if (event.type === "text_delta") emitLog(logger, { type: "provider", name: "provider.text_delta", detail: { length: event.text.length, totalLength: totalLengthBefore + event.text.length } })
  if (event.type === "tool_call") emitLog(logger, { type: "provider", name: "provider.tool_call", detail: { tool: event.call.name, callID: event.call.id } })
  if (event.type === "usage") emitLog(logger, { type: "provider", name: "provider.usage", detail: { inputTokens: event.inputTokens, outputTokens: event.outputTokens } })
  if (event.type === "done") emitLog(logger, { type: "provider", name: "provider.done" })
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

  get compactAt() {
    return this.inner.compactAt
  }

  get preserveRecentMessages() {
    return this.inner.preserveRecentMessages
  }

  add(message: Message) {
    this.logAdd(message)
    this.inner.add(message)
  }

  estimate(messages: Message[]) {
    return this.inner.estimate(messages)
  }

  needsCompaction() {
    return this.inner.needsCompaction()
  }

  compactionInput() {
    const input = this.inner.compactionInput()
    emitLog(this.logger, { type: "context", name: "context.compaction_input", detail: { providerMessageCount: input.length } })
    return input
  }

  compact(summary: string) {
    const before = snapshotContext(this.inner)
    const compacted = this.inner.compact(summary)
    emitLog(this.logger, { type: "context", name: "context.compact", detail: { compacted, before, after: snapshotContext(this.inner) } })
    return compacted
  }

  compose(input?: Parameters<ContextManagerLike["compose"]>[0]) {
    const providerMessages = this.inner.compose(input)
    emitLog(this.logger, { type: "data", name: "context -> provider", detail: { messageCount: this.inner.state.messages.length, providerMessageCount: providerMessages.length, toolNames: input?.tools.map((tool) => tool.name) ?? [], staticContext: Boolean(input) } })
    return providerMessages
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
