import { ContextManager, type ContextManagerLike } from "./context"
import { createMessage, textMessage, toolCallMessage, toolResultMessage, type AgentMode, type Message, type ToolCall } from "./message"
import { defaultPermissionRules, PermissionDeniedError, PermissionRejectedError, PermissionService } from "./permission"
import { createProvider, ProviderError, type Provider, type ProviderName } from "./provider"
import { Sandbox } from "./sandbox"
import { SkillService, type SkillServiceLike } from "./skill"
import { createBuiltinRegistry, type ToolRegistryLike } from "./tool"
import { createRunAspect, type RunAspect } from "./instrumentation"
import type { Logger } from "./logger"

export type Agent = {
  name: string
  mode: AgentMode
  systemPrompt: string
}

export type AgentRunState = "idle" | "preparing" | "streaming" | "tool_pending" | "tool_running" | "completed" | "failed" | "cancelled"

export type AgentRunResult = {
  status: "completed" | "failed"
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
    const agent = createAgent(mode)
    const usedTools: string[] = []
    let latestAssistantText = ""
    let latestReasoningText = ""
    let state = this.aspect.transition("preparing", { mode, provider: this.provider.name })
    this.context.add(textMessage("user", prompt))
    for (let step = 0; step < this.maxSteps; step += 1) {
      this.aspect.step(step + 1, this.maxSteps)
      this.context.compact()
      const tools = this.registry.list(mode)
      const skills = await this.skills.available()
      const providerMessages = this.context.compose({ agent, skills, tools })
      let reasoningText = ""
      let text = ""
      let toolCall: ToolCall | undefined
      let failureText: string | undefined
      state = this.aspect.transition("streaming", { step: step + 1 })
      try {
        for await (const event of this.provider.stream({ mode, prompt, messages: this.context.state.messages, providerMessages, tools })) {
          if (event.type === "reasoning_delta") {
            reasoningText += event.text
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
        }
      } catch (error) {
        if (error instanceof ProviderError) {
          const failureText = providerFailureText(error)
          const output = assistantOutput(reasoningText, text, failureText)
          this.context.add(textMessage("assistant", output))
          state = this.aspect.runFailed("provider_error", usedTools)
          return { status: "failed", text: output, messages: this.context.state.messages, usedTools, state }
        }
        throw error
      }
      if (failureText) {
        const output = assistantOutput(reasoningText, text, failureText)
        this.context.add(textMessage("assistant", output))
        state = this.aspect.runFailed("provider_error", usedTools)
        return { status: "failed", text: output, messages: this.context.state.messages, usedTools, state }
      }
      if (reasoningText) latestReasoningText = reasoningText
      if (text) latestAssistantText = text
      if (!toolCall) {
        const output = assistantOutput(reasoningText, text)
        this.context.add(textMessage("assistant", output))
        state = this.aspect.transition("completed", { usedTools })
        return { status: "completed", text: output, messages: this.context.state.messages, usedTools, state }
      }
      state = this.aspect.transition("tool_pending", { tool: toolCall.name, callID: toolCall.id })
      this.context.add(toolCallMessage(toolCall))
      usedTools.push(toolCall.name)
      state = this.aspect.transition("tool_running", { tool: toolCall.name, callID: toolCall.id })
      const result = await this.runTool(toolCall, mode)
      this.context.add(toolResultMessage({ callID: toolCall.id, toolName: toolCall.name, status: result.metadata.status === "succeeded" ? "succeeded" : result.metadata.status === "denied" ? "denied" : "failed", output: result.output, metadata: result.metadata }))
      state = this.aspect.transition("streaming", { nextStep: step + 2 })
    }
    const text = assistantOutput(latestReasoningText, latestAssistantText || `Stopped after max steps: ${this.maxSteps}`)
    this.context.add(createMessage("assistant", [{ type: "text", text }]))
    state = this.aspect.runFailed("max_steps", usedTools)
    return { status: "failed", text, messages: this.context.state.messages, usedTools, state }
  }

  private async runTool(call: ToolCall, mode: AgentMode) {
    try {
      return await this.registry.run(call.name, call.input, { agentMode: mode, sandbox: this.sandbox, permission: this.permission, skills: this.skills, messages: this.context.state.messages })
    } catch (error) {
      if (error instanceof PermissionDeniedError || error instanceof PermissionRejectedError) {
        return { title: call.name, output: error.message, metadata: { status: "denied", error: error.name } }
      }
      return { title: call.name, output: error instanceof Error ? error.message : String(error), metadata: { status: "failed", error: error instanceof Error ? error.name : "UnknownError" } }
    }
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
  return parts.reduce<string>((output, part) => {
    if (!output || output.endsWith("\n")) return `${output}${part}`
    return `${output}\n${part}`
  }, "")
}

export function createRunner(input: { root: string; provider?: ProviderName; mode?: AgentMode; logger?: Logger; context?: ContextManagerLike; onTextDelta?: (text: string) => void }) {
  return new AgentRunner({ root: input.root, provider: createProvider(input.provider ?? "fake"), permission: PermissionService.autoApprove(defaultPermissionRules(input.mode ?? "build")), logger: input.logger, context: input.context, onTextDelta: input.onTextDelta })
}
