import { ContextManager } from "./context"
import { createMessage, textMessage, toolCallMessage, toolResultMessage, type AgentMode, type Message, type ToolCall } from "./message"
import { defaultPermissionRules, PermissionDeniedError, PermissionRejectedError, PermissionService } from "./permission"
import { OpenAIProvider, FakeProvider, type Provider } from "./provider"
import { Sandbox } from "./sandbox"
import { SkillService } from "./skill"
import { createBuiltinRegistry, type ToolRegistry } from "./tool"

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
  provider?: Provider
  registry?: ToolRegistry
  permission?: PermissionService
  context?: ContextManager
  skills?: SkillService
  sandbox?: Sandbox
  maxSteps?: number
}

export function createAgent(mode: AgentMode): Agent {
  if (mode === "plan") return { name: "plan", mode, systemPrompt: "You are EasyCode in plan mode. Inspect context, avoid side effects, and return the final plan in <proposed_plan> tags." }
  return { name: "build", mode, systemPrompt: "You are EasyCode in build mode. Make the smallest safe code changes, use tools deliberately, and report concise results." }
}

export class AgentRunner {
  readonly root: string
  readonly provider: Provider
  readonly registry: ToolRegistry
  readonly permission: PermissionService
  readonly context: ContextManager
  readonly skills: SkillService
  readonly sandbox: Sandbox
  readonly maxSteps: number

  constructor(options: AgentRunnerOptions) {
    this.root = options.root
    this.provider = options.provider ?? new FakeProvider()
    this.registry = options.registry ?? createBuiltinRegistry()
    this.permission = options.permission ?? PermissionService.autoApprove(defaultPermissionRules("build"))
    this.context = options.context ?? new ContextManager()
    this.skills = options.skills ?? new SkillService(options.root)
    this.sandbox = options.sandbox ?? new Sandbox(options.root)
    this.maxSteps = options.maxSteps ?? 12
  }

  async run(prompt: string, mode: AgentMode): Promise<AgentRunResult> {
    const agent = createAgent(mode)
    const usedTools: string[] = []
    this.context.add(textMessage("user", prompt))
    for (let step = 0; step < this.maxSteps; step += 1) {
      this.context.compact()
      const tools = this.registry.list(mode)
      const providerMessages = this.context.compose({ agent, skills: await this.skills.available(), tools })
      let text = ""
      let toolCall: ToolCall | undefined
      for await (const event of this.provider.stream({ mode, prompt, messages: this.context.state.messages, providerMessages, tools })) {
        if (event.type === "text_delta") text += event.text
        if (event.type === "tool_call") toolCall = event.call
      }
      if (!toolCall) {
        this.context.add(textMessage("assistant", text))
        return { status: "completed", text, messages: this.context.state.messages, usedTools, state: "completed" }
      }
      this.context.add(toolCallMessage(toolCall))
      usedTools.push(toolCall.name)
      const result = await this.runTool(toolCall, mode)
      this.context.add(toolResultMessage({ callID: toolCall.id, toolName: toolCall.name, status: result.metadata.status === "succeeded" ? "succeeded" : result.metadata.status === "denied" ? "denied" : "failed", output: result.output, metadata: result.metadata }))
    }
    const text = `Stopped after max steps: ${this.maxSteps}`
    this.context.add(createMessage("assistant", [{ type: "text", text }]))
    return { status: "failed", text, messages: this.context.state.messages, usedTools, state: "failed" }
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

export function createProvider(name: "fake" | "openai") {
  return name === "openai" ? new OpenAIProvider() : new FakeProvider()
}

export function createRunner(input: { root: string; provider?: "fake" | "openai"; mode?: AgentMode }) {
  return new AgentRunner({ root: input.root, provider: createProvider(input.provider ?? "fake"), permission: PermissionService.autoApprove(defaultPermissionRules(input.mode ?? "build")) })
}
