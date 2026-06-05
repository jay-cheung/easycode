import type { AgentRunState } from "../agent"
import type { ProviderInputMessage } from "../message"
import { ProviderError, type Provider } from "../provider"
import type { SkillServiceLike } from "../skill"
import { type ContextManagerLike } from "../context"
import type { ToolRegistryLike } from "../tool"
import { emitLog, type Logger } from "../logger"
import { emitProviderTranscript, logProviderEvent, providerErrorDetail, providerInputTokenEstimate, providerUsageLog, renderProviderInput, type ProviderUsageLog } from "./instrumentation-provider"
import { LoggingContextDecorator } from "./instrumentation-context"

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
        if (summaryRequest) emitLog(logger, { type: "provider", name: "provider.summary_request", detail: { prompt: input.prompt, content: input.providerMessages.find((message) => message.content.includes("Conversation to summarize:"))?.content ?? input.providerMessages[0]?.content ?? "" } })
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

export function createRunAspect(logger?: Logger): RunAspect {
  return logger ? new LoggingRunAspect(logger) : new NoopRunAspect()
}
