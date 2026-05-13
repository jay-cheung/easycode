import { ContextManager, type ContextManagerLike } from "./context"
import { createMessage, textMessage, toolCallMessage, toolResultMessage, type AgentMode, type Message, type ToolCall } from "./message"
import { defaultPermissionRules, PermissionDeniedError, PermissionRejectedError, PermissionService } from "./permission"
import { createProvider, ProviderError, type Provider, type ProviderName } from "./provider"
import { Sandbox } from "./sandbox"
import { SkillService, type SkillServiceLike } from "./skill"
import { createBuiltinRegistry, type ToolRegistryLike } from "./tool"
import { createRunAspect, type RunAspect } from "./instrumentation"
import type { Logger } from "./logger"
import { BASE_COMPACT_PROMPT } from "./context/prompt"

export type Agent = {
  name: string
  mode: AgentMode
  systemPrompt: string
}

export type AgentRunState = "idle" | "preparing" | "streaming" | "tool_pending" | "tool_running" | "completed" | "failed" | "cancelled"

export type AgentRunResult = {
  status: "completed" | "failed"
  failureReason?: "provider_error" | "max_steps"
  text: string
  messages: Message[]
  usedTools: string[]
  state: AgentRunState
}

export type AgentRunnerOptions = {
  root: string
  provider: Provider
  registry?: ToolRegistryLike
  permission?: PermissionService
  context?: ContextManagerLike
  skills?: SkillServiceLike
  sandbox?: Sandbox
  maxSteps?: number
  logger?: Logger
  aspect?: RunAspect
  onTextDelta?: (text: string) => void
}

export function createAgent(mode: AgentMode): Agent {
  if (mode === "plan") return { name: "plan", mode, systemPrompt: "You are EasyCode in plan mode. Inspect context, avoid side effects, and return the final plan in <proposed_plan> tags." }
  return { name: "build", mode, systemPrompt: "You are EasyCode in build mode. Make the smallest safe code changes, use tools deliberately, and report concise results." }
}

export class AgentRunner {
  readonly root: string
  readonly provider: Provider
  readonly registry: ToolRegistryLike
  readonly permission: PermissionService
  readonly context: ContextManagerLike
  readonly skills: SkillServiceLike
  readonly sandbox: Sandbox
  readonly maxSteps: number
  readonly aspect: RunAspect
  readonly onTextDelta?: (text: string) => void

  constructor(options: AgentRunnerOptions) {
    this.root = options.root
    this.aspect = options.aspect ?? createRunAspect(options.logger)
    this.provider = this.aspect.instrumentProvider(options.provider)
    this.registry = this.aspect.instrumentRegistry(options.registry ?? createBuiltinRegistry())
    this.permission = options.permission ?? PermissionService.autoApprove(defaultPermissionRules("build"))
    this.context = this.aspect.instrumentContext(options.context ?? new ContextManager())
    this.skills = this.aspect.instrumentSkills(options.skills ?? new SkillService(options.root))
    this.sandbox = options.sandbox ?? new Sandbox(options.root)
    this.maxSteps = options.maxSteps ?? 12
    this.onTextDelta = options.onTextDelta
  }

  async run(prompt: string, mode: AgentMode): Promise<AgentRunResult> {
    const effectiveMode = this.effectiveMode(prompt, mode)
    const agent = createAgent(effectiveMode)
    const usedTools: string[] = []
    let latestAssistantText = ""
    let reasoningTranscript = ""
    let state = this.aspect.transition("preparing", { mode: effectiveMode, requestedMode: mode, provider: this.provider.name })
    this.context.add(textMessage("user", prompt))
    const tools = this.registry.list(effectiveMode)
    const skills = await this.skills.available()
    for (let step = 0; step < this.maxSteps; step += 1) {
      this.aspect.step(step + 1, this.maxSteps)
      await this.compactContext(effectiveMode)
      const providerMessages = this.context.compose(step === 0 ? { agent, skills, tools } : undefined)
      let text = ""
      let toolCall: ToolCall | undefined
      let failureText: string | undefined
      state = this.aspect.transition("streaming", { step: step + 1 })
      try {
        for await (const event of this.provider.stream({ mode: effectiveMode, prompt, messages: this.context.state.messages, providerMessages, tools })) {
          if (event.type === "reasoning_delta") {
            reasoningTranscript = appendOutput(reasoningTranscript, event.text)
            this.onTextDelta?.(formatReasoningText(event.text))
          }
          if (event.type === "text_delta") {
            text += event.text
            this.onTextDelta?.(event.text)
          }
          if (event.type === "failure") {
            failureText = event.error.output || event.error.message
            this.onTextDelta?.(failureText)
          }
          if (event.type === "tool_call") toolCall = event.call
          if (event.type === "usage") this.context.recordUsage(event.inputTokens)
        }
      } catch (error) {
        if (error instanceof ProviderError) {
          const failureText = providerFailureText(error)
          const output = assistantOutput(reasoningTranscript, text, failureText)
          this.context.add(textMessage("assistant", output))
          state = this.aspect.runFailed("provider_error", usedTools)
          return { status: "failed", failureReason: "provider_error", text: output, messages: this.context.state.messages, usedTools, state }
        }
        throw error
      }
      if (failureText) {
        const output = assistantOutput(reasoningTranscript, text, failureText)
        this.context.add(textMessage("assistant", output))
        state = this.aspect.runFailed("provider_error", usedTools)
        return { status: "failed", failureReason: "provider_error", text: output, messages: this.context.state.messages, usedTools, state }
      }
      if (text) latestAssistantText = text
      if (!toolCall) {
        const output = assistantOutput(reasoningTranscript, text)
        this.context.add(textMessage("assistant", output))
        state = this.aspect.transition("completed", { usedTools })
        return { status: "completed", text: output, messages: this.context.state.messages, usedTools, state }
      }
      state = this.aspect.transition("tool_pending", { tool: toolCall.name, callID: toolCall.id })
      this.context.add(toolCallMessage(toolCall))
      usedTools.push(toolCall.name)
      state = this.aspect.transition("tool_running", { tool: toolCall.name, callID: toolCall.id })
      const result = await this.runTool(toolCall, effectiveMode, mode)
      this.context.add(toolResultMessage({ callID: toolCall.id, toolName: toolCall.name, status: result.metadata.status === "succeeded" ? "succeeded" : result.metadata.status === "denied" ? "denied" : "failed", output: result.output, metadata: result.metadata }))
      if (effectiveMode === "plan" && toolCall.name === "plan_exit" && result.metadata.status === "succeeded") {
        const output = assistantOutput(reasoningTranscript, result.output)
        this.onTextDelta?.(result.output)
        this.context.add(textMessage("assistant", output))
        state = this.aspect.transition("completed", { usedTools })
        return { status: "completed", text: output, messages: this.context.state.messages, usedTools, state }
      }
      state = this.aspect.transition("streaming", { nextStep: step + 2 })
    }
    const text = assistantOutput(reasoningTranscript, latestAssistantText || `Stopped after max steps: ${this.maxSteps}`)
    this.context.add(createMessage("assistant", [{ type: "text", text }]))
    state = this.aspect.runFailed("max_steps", usedTools)
    return { status: "failed", failureReason: "max_steps", text, messages: this.context.state.messages, usedTools, state }
  }

  private async runTool(call: ToolCall, mode: AgentMode, requestedMode = mode) {
    try {
      return await this.registry.run(call.name, call.input, { agentMode: mode, sandbox: this.sandbox, permission: this.permissionFor(mode, requestedMode), skills: this.skills, messages: this.context.state.messages })
    } catch (error) {
      if (error instanceof PermissionDeniedError || error instanceof PermissionRejectedError) {
        return { title: call.name, output: error.message, metadata: { status: "denied", error: error.name } }
      }
      return { title: call.name, output: error instanceof Error ? error.message : String(error), metadata: { status: "failed", error: error instanceof Error ? error.name : "UnknownError" } }
    }
  }

  private async compactContext(mode: AgentMode) {
    if (!this.context.needsCompaction()) return
    const providerMessages = [{ role: "user" as const, content: compactPrompt(this.context.compactionInput()) }]
    let summary = ""
    for await (const event of this.provider.stream({ mode, prompt: "Summarize conversation for context compaction", messages: [], providerMessages, tools: [] })) {
      if (event.type === "text_delta") summary += event.text
      if (event.type === "usage") this.context.recordUsage(event.inputTokens)
      if (event.type === "failure") throw new ProviderError(event.error.message, { output: event.error.output })
    }
    this.context.compact(extractSummary(summary))
  }

  private effectiveMode(prompt: string, mode: AgentMode): AgentMode {
    if (mode !== "plan") return mode
    if (!isPlanApproval(prompt)) return mode
    return contextHasProposedPlan(this.context.state.messages) ? "build" : mode
  }

  private permissionFor(mode: AgentMode, requestedMode: AgentMode) {
    if (mode === requestedMode) return this.permission
    return this.permission.withRules(defaultPermissionRules(mode))
  }
}

function providerFailureText(error: ProviderError) {
  return error.output?.trim() || error.message
}

function formatReasoningText(text: string) {
  return `<reasoning>\n${text}\n</reasoning>\n`
}

function assistantOutput(reasoningText: string, text: string, failureText?: string) {
  const parts = [reasoningText ? formatReasoningText(reasoningText) : "", text, failureText ?? ""].filter((part) => part.length > 0)
  return parts.reduce<string>(appendOutput, "")
}

function appendOutput(output: string, part: string) {
  if (!output || output.endsWith("\n")) return `${output}${part}`
  return `${output}\n${part}`
}

function compactPrompt(messages: Array<{ role: string; content: string }>) {
  const transcript = messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")
  return `${BASE_COMPACT_PROMPT}\n\nConversation to summarize:\n<conversation>\n${transcript}\n</conversation>`
}

function extractSummary(output: string) {
  return output.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/)?.[1]?.trim() ?? output.trim()
}

function isPlanApproval(prompt: string) {
  const text = prompt.trim().toLowerCase()
  return /^(执行吧|执行|确认|接受|同意|继续|开始|approve|accepted|execute|go ahead|yes|y)$/i.test(text)
}

function contextHasProposedPlan(messages: Message[]) {
  return messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(part.text)))
}

export function createRunner(input: { root: string; provider?: ProviderName; mode?: AgentMode; logger?: Logger; context?: ContextManagerLike; permission?: PermissionService; onTextDelta?: (text: string) => void }) {
  return new AgentRunner({ root: input.root, provider: createProvider(input.provider ?? "fake"), permission: input.permission ?? PermissionService.autoApprove(defaultPermissionRules(input.mode ?? "build")), logger: input.logger, context: input.context, onTextDelta: input.onTextDelta })
}
