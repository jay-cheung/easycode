import type { AgentRunState } from "./agent"
import type { Message, ToolCall } from "./message"
import type { Provider, ProviderEvent } from "./provider"
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
        for await (const event of provider.stream(input)) {
          logProviderEvent(logger, event, totalLength)
          if (event.type === "text_delta") totalLength += event.text.length
          yield event
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
        let validated = false
        if (!tool) emitLog(logger, { type: "tool", name: "tool.missing", detail: { tool: name } })
        if (tool && !tool.modes.includes(ctx.agentMode)) emitLog(logger, { type: "tool", name: "tool.disabled", detail: { tool: name, mode: ctx.agentMode } })
        if (tool) {
          emitLog(logger, { type: "tool", name: "tool.validate.start", detail: { tool: name } })
          const parsed = tool.inputSchema.safeParse(input)
          if (parsed.success) {
            validated = true
            emitLog(logger, { type: "tool", name: "tool.validate.succeeded", detail: { tool: name } })
            const patterns = tool.patterns(parsed.data, ctx)
            emitLog(logger, { type: "tool", name: "permission.evaluate", detail: { tool: name, permission: tool.permission, patterns } })
          } else {
            emitLog(logger, { type: "tool", name: "tool.validate.failed", detail: { tool: name, issues: parsed.error.issues } })
          }
        }
        try {
          const result = await registry.run(name, input, ctx)
          if (tool && validated && result.metadata.status !== "denied") emitLog(logger, { type: "tool", name: "permission.allowed", detail: { tool: name, permission: tool.permission } })
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

function logProviderEvent(logger: Logger, event: ProviderEvent, totalLengthBefore: number) {
  if (event.type === "text_delta") emitLog(logger, { type: "provider", name: "provider.text_delta", detail: { length: event.text.length, totalLength: totalLengthBefore + event.text.length } })
  if (event.type === "tool_call") emitLog(logger, { type: "provider", name: "provider.tool_call", detail: { tool: event.call.name, callID: event.call.id } })
  if (event.type === "usage") emitLog(logger, { type: "provider", name: "provider.usage", detail: { inputTokens: event.inputTokens, outputTokens: event.outputTokens } })
  if (event.type === "done") emitLog(logger, { type: "provider", name: "provider.done" })
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

  compact() {
    const before = snapshotContext(this.inner)
    const compacted = this.inner.compact()
    emitLog(this.logger, { type: "context", name: "context.compact", detail: { compacted, before, after: snapshotContext(this.inner) } })
    return compacted
  }

  compose(input: Parameters<ContextManagerLike["compose"]>[0]) {
    const providerMessages = this.inner.compose(input)
    emitLog(this.logger, { type: "data", name: "context -> provider", detail: { messageCount: this.inner.state.messages.length, providerMessageCount: providerMessages.length, toolNames: input.tools.map((tool) => tool.name) } })
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
