import { defaultCachePricing, type CachePricing } from "./cache-policy"
import { ContextManager, type ContextManagerLike, type LedgerKind, type LedgerRecord, type LedgerScope, type LedgerStatus } from "./context"
import { createMessage, reasoningPart, textPart, userMessage, toolCallMessage, toolResultMessage, type AgentMode, type ImagePart, type Message, type MessagePart, type ToolCall } from "./message"
import { defaultPermissionRules, PermissionService } from "./permission"
import { createProvider, ProviderError, type Provider, type ProviderEvent, type ProviderName } from "./provider"
import { Sandbox } from "./sandbox"
import { SkillService, type SkillServiceLike } from "./skill"
import { createBuiltinRegistry, formatRepoMap, type ToolRegistryLike } from "./tool"
import { CliCodeNavigator } from "./tool/code-navigator"
import { createRunAspect, type RunAspect } from "./instrumentation"
import type { Logger } from "./logger"
import { BASE_COMPACT_PROMPT } from "./context/prompt"
import type { PermissionRule } from "./permission"
import { defaultSessionSettings, type SessionSettings } from "./settings"
import type { ProviderRunMetrics, RunUiEvent } from "./ui/timeline"

export type Agent = {
  name: string
  mode: AgentMode
  systemPrompt: string
}

const stableOperatingProtocol = [
  "Stable operating protocol:",
  "1. Read the current repository state before making claims about code behavior. Prefer targeted file reads and fast text search.",
  "2. Keep changes scoped to the user's request and the surrounding ownership boundary. Avoid unrelated refactors and metadata churn.",
  "3. Preserve user work. Never revert changes you did not make unless explicitly asked.",
  "4. Treat tool outputs as evidence. Summarize large outputs, keep paths and commands reproducible, and request more detail only when needed.",
  "5. For implementation work, make the smallest coherent change, then run focused verification before broader checks.",
  "6. For planning work, avoid side effects and return one complete proposed plan in the expected tags.",
  "7. Keep stable instructions, tool contracts, and skill descriptions ahead of dynamic conversation history to preserve prompt-cache prefixes.",
  "8. Put run-specific facts such as user prompts, command outputs, errors, timestamps, and temporary paths in the dynamic history area.",
  "9. When context is large, prefer stable facts, recent user intent, and reproducible references over long raw logs.",
  "10. Report concise results with changed files, verification, and remaining risks when relevant.",
  "11. Keep answers grounded in the exact files, commands, and provider events available in the current run.",
  "12. Treat repository operations as stateful work: inspect, decide, change, verify, and summarize in that order.",
  "13. Prefer deterministic command forms and deterministic output summaries so repeated turns keep a stable prefix.",
  "14. For code review style tasks, lead with concrete findings and file references before general summaries.",
  "15. For implementation tasks, update tests near the changed behavior before broadening verification.",
  "16. For failures, preserve the failing command, short error text, and the next concrete recovery action.",
  "17. For cache efficiency, keep this protocol unchanged across turns; task-specific information belongs after it.",
  "18. Tool calls should be purposeful: read/search before editing, avoid duplicate exploration, and keep outputs bounded.",
  "18a. For code navigation, you MUST: first check repo_map, then use find_definition or rg_search to locate symbols, then use read_lines for the smallest relevant range. Use grep only as a fallback. Full-file read is FORBIDDEN except for files under 100 lines or when you have a confirmed edit target and know the exact line range.",
  "18b. For repository diffs, use git_diff in summary/files/stat mode first, then request a single-file patch only when needed; avoid bash git diff because full patches waste context.",
  "19. Context quality is more important than raw volume: retain facts that affect correctness and drop redundant logs.",
  "20. Session continuity should preserve user intent, accepted plans, changed files, and verification outcomes.",
  "21. When active skills are listed, load full skill text only when the task actually requires those instructions.",
  "22. Use stable names and stable ordering for repeated context sections so provider-side prefix caches can match exactly.",
  "23. Keep fixed guidance in this anchor and avoid introducing per-run values such as dates, random ids, absolute temp paths, or session filenames here.",
  "24. Prefer compact, structured records for tool results: status, command or path, key output, truncation marker, and where to reread full data.",
  "25. Use the active window for current reasoning and the summary area for older dynamic facts; do not mix either into the fixed anchor.",
  "26. When cost and quality trade off, choose the option that preserves correctness while lowering cache-miss and output token cost.",
].join("\n")

const defaultToolProgressIntervalMs = 10_000
const defaultProviderProgressIntervalMs = 10_000

export type AgentRunState = "idle" | "preparing" | "streaming" | "tool_pending" | "tool_running" | "completed" | "failed" | "cancelled"

export type AgentRunResult = {
  status: "completed" | "failed" | "cancelled"
  failureReason?: "provider_error" | "max_steps" | "cancelled"
  text: string
  reasoning?: string
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
  onEvent?: (event: RunUiEvent) => void
  toolProgressIntervalMs?: number
  providerProgressIntervalMs?: number
  settings?: SessionSettings
}

export function createAgent(mode: AgentMode): Agent {
  if (mode === "plan") return { name: "plan", mode, systemPrompt: `You are EasyCode in plan mode. Inspect context, avoid side effects, and return the final plan in <proposed_plan> tags.\n\n${stableOperatingProtocol}` }
  return { name: "build", mode, systemPrompt: `You are EasyCode in build mode. Make the smallest safe code changes, use tools deliberately, and report concise results.\n\n${stableOperatingProtocol}` }
}

export class AgentRunner {
  readonly root: string
  readonly provider: Provider
  readonly registry: ToolRegistryLike
  readonly permission: PermissionService
  readonly context: ContextManagerLike
  readonly skills: SkillServiceLike
  readonly sandbox: Sandbox
  readonly aspect: RunAspect
  readonly onTextDelta?: (text: string) => void
  readonly onEvent?: (event: RunUiEvent) => void
  readonly toolProgressIntervalMs: number
  readonly providerProgressIntervalMs: number
  readonly settings: SessionSettings

  constructor(options: AgentRunnerOptions) {
    this.root = options.root
    this.aspect = options.aspect ?? createRunAspect(options.logger)
    this.provider = this.aspect.instrumentProvider(options.provider)
    this.registry = this.aspect.instrumentRegistry(options.registry ?? createBuiltinRegistry())
    this.permission = options.permission ?? PermissionService.autoApprove(defaultPermissionRules("build"))
    this.context = this.aspect.instrumentContext(options.context ?? new ContextManager())
    this.skills = this.aspect.instrumentSkills(options.skills ?? new SkillService(options.root))
    this.sandbox = options.sandbox ?? new Sandbox(options.root)
    this.onTextDelta = options.onTextDelta
    this.onEvent = options.onEvent
    this.toolProgressIntervalMs = options.toolProgressIntervalMs ?? defaultToolProgressIntervalMs
    this.providerProgressIntervalMs = options.providerProgressIntervalMs ?? defaultProviderProgressIntervalMs
    this.settings = options.settings ?? defaultSessionSettings(this.provider.name)
    const providerContextWindow = this.provider.capabilities?.contextWindowTokens
    this.context.configureStrategy({
      contextWindowTokens: providerContextWindow ?? Math.max(this.context.strategyState.maxTokens, options.settings?.maxTokens ?? 0),
      maxTokens: options.settings?.maxTokens ?? this.context.strategyState.maxTokens,
      maxSteps: options.maxSteps ?? options.settings?.maxSteps ?? this.context.strategyState.maxSteps,
      ...(options.settings?.responseReserveTokens === undefined ? {} : { responseReserveTokens: options.settings.responseReserveTokens }),
    })
  }

  get maxSteps() {
    return this.context.strategyState.maxSteps
  }

  async run(prompt: string, mode: AgentMode, input: { images?: ImagePart[]; signal?: AbortSignal } = {}): Promise<AgentRunResult> {
    const effectiveMode = this.effectiveMode(prompt, mode)
    const agent = createAgent(effectiveMode)
    const usedTools: string[] = []
    let latestAssistantText = ""
    let reasoningTranscript = ""
    let state = this.aspect.transition("preparing", { mode: effectiveMode, requestedMode: mode, provider: this.provider.name })
    const providerMetrics = createProviderMetrics(this.provider.name, this.provider.model)
    this.onEvent?.({ type: "run_start", mode: effectiveMode, provider: this.provider.name, model: this.provider.model })
    this.context.add(userMessage(prompt, input.images ?? []))
    this.recordRunIntent(prompt)
    await this.refreshRepoMap(input.signal, prompt)
    if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
    const tools = this.registry.list(effectiveMode)
    const skills = await this.skills.available()
    const selectedSkills = await this.selectedSkills()
    for (let step = 0; step < this.maxSteps; step += 1) {
      if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
      this.aspect.step(step + 1, this.maxSteps)
      try {
        await this.compactContext(effectiveMode, input.signal, providerMetrics)
      } catch (error) {
        if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
        throw error
      }
      if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
      const plan = this.context.planRequest({ step, agent, skills, selectedSkills, tools })
      const providerMessages = plan.providerMessages
      let text = ""
      let toolCall: ToolCall | undefined
      let failureText: string | undefined
      state = this.aspect.transition("streaming", { step: step + 1 })
      const stopProviderProgress = this.startProviderProgressTimer()
      const metricCall = startProviderMetricCall(providerMetrics)
      try {
        for await (const event of this.provider.stream({ mode: effectiveMode, prompt, messages: this.context.state.messages, providerMessages, tools, signal: input.signal })) {
          observeProviderMetricEvent(providerMetrics, metricCall, event)
          if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, appendOutput(text, "Run cancelled by user."), providerMetrics)
          if (event.type === "reasoning_delta") {
            stopProviderProgress()
            reasoningTranscript = appendOutput(reasoningTranscript, event.text)
            this.onEvent?.({ type: "reasoning_delta", text: event.text })
            this.onTextDelta?.(event.text)
          }
          if (event.type === "text_delta") {
            stopProviderProgress()
            text += event.text
            this.onEvent?.({ type: "text_delta", text: event.text })
            this.onTextDelta?.(event.text)
          }
          if (event.type === "failure") {
            stopProviderProgress()
            failureText = runFailureText(event.error.output || event.error.message, "provider_error")
            this.onEvent?.({ type: "failure", text: failureText })
            this.onTextDelta?.(failureText)
          }
          if (event.type === "tool_call") {
            stopProviderProgress()
            toolCall = event.call
            this.onEvent?.({ type: "tool_call", call: event.call })
          }
          if (event.type === "usage") {
            this.context.observeUsage(event)
          }
        }
      } catch (error) {
        stopProviderProgress()
        if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, appendOutput(text, "Run cancelled by user."), providerMetrics)
        if (error instanceof ProviderError) {
          const failureText = runFailureText(providerFailureText(error), "provider_error")
          this.onEvent?.({ type: "failure", text: failureText })
          const output = appendOutput(text, failureText)
          this.context.add(assistantMessage(reasoningTranscript, output))
          this.context.recordRunOutcome({ status: "failed", failureReason: "provider_error" })
          state = this.aspect.runFailed("provider_error", usedTools)
          this.emitRunDone("failed", providerMetrics)
          return { status: "failed", failureReason: "provider_error", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
        }
        throw error
      } finally {
        finishProviderMetricCall(providerMetrics, metricCall)
        stopProviderProgress()
      }
      if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, appendOutput(text, "Run cancelled by user."), providerMetrics)
      if (failureText) {
        const output = appendOutput(text, failureText)
        this.context.add(assistantMessage(reasoningTranscript, output))
        this.context.recordRunOutcome({ status: "failed", failureReason: "provider_error" })
        state = this.aspect.runFailed("provider_error", usedTools)
        this.emitRunDone("failed", providerMetrics)
        return { status: "failed", failureReason: "provider_error", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
      }
      if (text) latestAssistantText = text
      if (!toolCall) {
        const output = text
        this.context.add(assistantMessage(reasoningTranscript, output))
        this.context.recordRunOutcome({ status: "completed" })
        state = this.aspect.transition("completed", { usedTools })
        this.emitRunDone("completed", providerMetrics)
        return { status: "completed", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
      }
      state = this.aspect.transition("tool_pending", { tool: toolCall.name, callID: toolCall.id })
      this.context.add(toolCallMessage(toolCall))
      usedTools.push(toolCall.name)
      state = this.aspect.transition("tool_running", { tool: toolCall.name, callID: toolCall.id })
      const result = await this.runTool(toolCall, effectiveMode, input.signal)
      this.recordToolOutcome(toolCall, result, prompt)
      this.context.add(toolResultMessage({ callID: toolCall.id, toolName: toolCall.name, status: result.metadata.status === "succeeded" ? "succeeded" : result.metadata.status === "denied" ? "denied" : "failed", output: result.output, metadata: result.metadata }))
      this.onEvent?.({ type: "tool_result", callID: toolCall.id, toolName: toolCall.name, title: result.title, status: String(result.metadata.status ?? "failed"), output: result.output, durationMs: numericMetadata(result.metadata.durationMs) })
      if (input.signal?.aborted || result.metadata.cancelled === true) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
      if (effectiveMode === "plan" && toolCall.name === "plan_exit" && result.metadata.status === "succeeded") {
        const output = result.output
        this.onEvent?.({ type: "text_delta", text: result.output })
        this.onTextDelta?.(result.output)
        this.context.add(assistantMessage(reasoningTranscript, output))
        this.context.recordRunOutcome({ status: "completed" })
        state = this.aspect.transition("completed", { usedTools })
        this.emitRunDone("completed", providerMetrics)
        return { status: "completed", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
      }
      state = this.aspect.transition("streaming", { nextStep: step + 2 })
    }
    const maxStepsText = runFailureText(`Stopped after maxSteps (${this.maxSteps}).`, "max_steps")
    const text = appendOutput(latestAssistantText, maxStepsText)
    this.onEvent?.({ type: "failure", text: maxStepsText })
    this.onTextDelta?.(maxStepsText)
    this.context.add(assistantMessage(reasoningTranscript, text))
    this.context.recordRunOutcome({ status: "failed", failureReason: "max_steps" })
    state = this.aspect.runFailed("max_steps", usedTools)
    this.emitRunDone("failed", providerMetrics)
    return { status: "failed", failureReason: "max_steps", text, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
  }

  private async runTool(call: ToolCall, mode: AgentMode, signal?: AbortSignal) {
    let progressTimer: ReturnType<typeof setInterval> | undefined
    try {
      return await this.registry.run(call.name, call.input, {
        agentMode: mode,
        sandbox: this.sandbox,
        permission: this.permissionFor(mode),
        skills: this.skills,
        messages: this.context.state.messages,
        signal,
        onExecuteStart: () => {
          progressTimer = this.startToolProgressTimer(call, Date.now())
        },
      })
    } catch (error) {
      return { title: call.name, output: error instanceof Error ? error.message : String(error), metadata: { status: "failed", error: error instanceof Error ? error.name : "UnknownError" } }
    } finally {
      if (progressTimer) clearInterval(progressTimer)
    }
  }

  private startToolProgressTimer(call: ToolCall, startedAt: number) {
    if (!this.onEvent || call.name !== "bash" || this.toolProgressIntervalMs <= 0) return undefined
    return setInterval(() => {
      this.onEvent?.({ type: "tool_progress", callID: call.id, toolName: call.name, elapsedMs: Date.now() - startedAt })
    }, this.toolProgressIntervalMs)
  }

  private startProviderProgressTimer() {
    if (!this.onEvent || this.providerProgressIntervalMs <= 0) return () => {}
    const startedAt = Date.now()
    let stopped = false
    const timer = setInterval(() => {
      if (stopped) return
      this.onEvent?.({ type: "provider_progress", provider: this.provider.name, model: this.provider.model, elapsedMs: Date.now() - startedAt })
    }, this.providerProgressIntervalMs)
    return () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    }
  }

  private cancelledResult(reasoningTranscript: string, usedTools: string[], output = "Run cancelled by user.", providerMetrics?: ProviderMetricsAccumulator) {
    const text = appendOutput(output.trim(), "Continue with another message when ready.")
    this.onEvent?.({ type: "failure", text })
    this.context.add(assistantMessage(reasoningTranscript, text))
    const state = this.aspect.transition("cancelled", { usedTools })
    this.emitRunDone("cancelled", providerMetrics)
    return { status: "cancelled" as const, failureReason: "cancelled" as const, text, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
  }

  private async compactContext(mode: AgentMode, signal?: AbortSignal, providerMetrics?: ProviderMetricsAccumulator) {
    if (!this.context.needsCompaction()) return
    const providerMessages = [{ role: "user" as const, content: compactPrompt(this.context.compactionInput()) }]
    let summary = ""
    const metricCall = startProviderMetricCall(providerMetrics)
    try {
      for await (const event of this.provider.stream({ mode, prompt: "Summarize conversation for context compaction", messages: [], providerMessages, tools: [], signal })) {
        observeProviderMetricEvent(providerMetrics, metricCall, event)
        if (event.type === "text_delta") summary += event.text
        if (event.type === "usage") this.context.recordUsage(event.inputTokens)
        if (event.type === "failure") throw new ProviderError(event.error.message, { output: event.error.output })
      }
    } finally {
      finishProviderMetricCall(providerMetrics, metricCall)
    }
    this.context.compact(extractSummary(summary))
  }

  private emitRunDone(status: string, providerMetrics: ProviderMetricsAccumulator | undefined) {
    if (providerMetrics && providerMetrics.calls > 0) this.onEvent?.({ type: "provider_metrics", metrics: finalizeProviderMetrics(providerMetrics) })
    this.onEvent?.({ type: "run_done", status })
  }

  private async selectedSkills() {
    const selected = this.settings.selectedSkills ?? []
    const loaded = await Promise.all(selected.map((name) => this.skills.load(name)))
    return loaded.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
  }

  private effectiveMode(prompt: string, mode: AgentMode): AgentMode {
    if (mode !== "plan") return mode
    if (!isPlanApproval(prompt)) return mode
    return contextHasProposedPlan(this.context.state.messages) ? "build" : mode
  }

  private permissionFor(mode: AgentMode) {
    const rules = defaultPermissionRules(mode)
    if (samePermissionRules(this.permission.rules, rules)) return this.permission
    return this.permission.withRules(rules)
  }

  private recordRunIntent(prompt: string) {
    const normalized = compactLine(prompt)
    if (!normalized) return
    const turn = this.context.state.messages.length
    this.context.updateLedger({
      current: [
        ledgerRecord("intent", "current_user_request", truncateForLedger(normalized, 240), "current", turn, { evidence: { source: "user", messageIndex: Math.max(0, turn - 1) } }),
        ledgerRecord("constraint", "main_objective", "complete latest request end-to-end; do not shrink scope unless user changes it.", "current", turn),
        ledgerRecord("constraint", "failure_recovery_rule", "after tool failure, keep objective and take nearest safe recovery.", "current", turn),
        ledgerRecord("constraint", "full_scope_finality", "do not treat probes, subsets, or dry runs as final for full-scope requests.", "current", turn),
        ledgerRecord("constraint", "evidence_grounding", "do not claim evidence unless it is in messages, summary, ledger, files, or tool outputs.", "current", turn),
      ],
    })
  }

  private async refreshRepoMap(signal: AbortSignal | undefined, prompt?: string) {
    if (signal?.aborted) return
    const turn = this.context.state.messages.length
    try {
      const map = await new CliCodeNavigator(this.sandbox, { signal }).repoMap({})
      
      let checkpointText = `repo_map ${map.cache.hit ? "cache hit" : "refreshed"}: ${map.entries.length} files at ${map.cache.path}`
      let dynamicMapRecord: LedgerRecord | undefined
      
      if (prompt) {
        const filteredMap = await new CliCodeNavigator(this.sandbox, { signal }).repoMap({ query: prompt })
        if (filteredMap.entries.length > 0) {
          checkpointText += ` (query-targeted subset containing ${filteredMap.entries.length} relevant files)`
          const formatted = formatRepoMap(filteredMap)
          dynamicMapRecord = ledgerRecord(
            "entity",
            "query_targeted_repo_map",
            `A skeletal outline of the most relevant files/symbols for the query:\n${formatted}`,
            "current",
            turn,
            { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }
          )
        }
      }

      this.context.updateLedger({
        current: [
          ledgerRecord("checkpoint", "repo_map_cache", checkpointText, "current", turn, { evidence: { source: "assistant" }, scope: { files: [map.cache.path], topics: ["repo_map", "code_navigation"] } }),
          ledgerRecord("constraint", "code_navigation_entrypoint", "repo_map cache is prewarmed at conversation start; prefer repo_map, find_definition, rg_search, and read_lines before grep or full-file read.", "current", turn, { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }),
          ...(dynamicMapRecord ? [dynamicMapRecord] : []),
        ],
      })
    } catch (error) {
      this.context.updateLedger({
        current: [
          ledgerRecord("failure", "repo_map_prewarm_failure", error instanceof Error ? error.message : String(error), "current", turn, { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }),
          ledgerRecord("constraint", "code_navigation_fallback", "repo_map prewarm failed; use find_definition, rg_search, read_lines, and grep fallback with bounded results.", "current", turn, { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }),
        ],
      })
    }
  }

  private recordToolOutcome(call: ToolCall, result: Awaited<ReturnType<AgentRunner["runTool"]>>, prompt: string) {
    const turn = this.context.state.messages.length
    if (result.metadata.status === "succeeded") {
      const files = toolScopeFiles(call, result)
      const toolEvidence = { source: "tool" as const, toolCallID: call.id.slice(0, 12) }
      const current: LedgerRecord[] = [
        ledgerRecord("failure", "last_tool_failure", `resolved by ${call.name}`, "resolved", turn, { reason: "a later tool call succeeded", evidence: toolEvidence }),
      ]
      if (files.length) {
        current.push(ledgerRecord("file", files.join(","), `${call.name} succeeded: ${truncateForLedger(result.title, 160)}`, "current", turn, { evidence: toolEvidence, scope: { files } }))
      } else {
        current.push(ledgerRecord("checkpoint", "last_successful_tool", `${call.name} ${truncateForLedger(result.title, 120)}`, "current", turn, { evidence: toolEvidence }))
      }
      this.context.updateLedger({
        current,
      })
      return
    }

    const summary = toolFailureSummary(call, result)
    const recovery = recoveryHintForToolFailure(call, result)
    const failureEvidence = { source: "tool" as const, toolCallID: call.id.slice(0, 12) }
    this.context.updateLedger({
      current: [
        ledgerRecord("failure", "last_tool_failure", summary, "current", turn, { evidence: failureEvidence, scope: toolScopeFiles(call, result).length ? { files: toolScopeFiles(call, result) } : undefined }),
        ledgerRecord("constraint", "tool_failure_scope_rule", "tool failure requires recovery, not abandoning or silently shrinking scope.", "current", turn),
        ledgerRecord("intent", "main_objective_still_active", truncateForLedger(compactLine(prompt), 200), "current", turn, { evidence: { source: "user" } }),
        ledgerRecord("constraint", "next_recovery_action", recovery, "current", turn),
      ],
    })
  }
}

function samePermissionRules(left: PermissionRule[], right: PermissionRule[]) {
  if (left.length !== right.length) return false
  return left.every((rule, index) => {
    const other = right[index]
    return other && rule.permission === other.permission && rule.pattern === other.pattern && rule.action === other.action
  })
}

function providerFailureText(error: ProviderError) {
  return error.output?.trim() || error.message
}

function runFailureText(text: string, reason: "provider_error" | "max_steps") {
  const trimmed = text.trim()
  const guidance = reason === "max_steps" ? "Continue with another message to keep going." : "Run failed. Continue with another message to retry or provide more direction."
  return appendOutput(trimmed, guidance)
}

function numericMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function appendOutput(output: string, part: string) {
  if (!output || output.endsWith("\n")) return `${output}${part}`
  return `${output}\n${part}`
}

function compactLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function truncateForLedger(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 15))}...[truncated]`
}

function toolFailureSummary(call: ToolCall, result: { title: string; output: string; metadata: Record<string, unknown> }) {
  const status = String(result.metadata.status ?? "failed")
  const error = typeof result.metadata.error === "string" ? ` ${result.metadata.error}` : ""
  const output = compactLine(result.output)
  return `${call.name} ${status}${error}: ${truncateForLedger(output || result.title, 220)}`
}

function recoveryHintForToolFailure(call: ToolCall, result: { output: string; metadata: Record<string, unknown> }) {
  const output = `${result.output}\n${JSON.stringify(result.metadata)}\n${JSON.stringify(call.input)}`
  if (call.name === "bash" && /SandboxPathEscapeError|path_boundary_escape|Path escapes project root|\/tmp|\/dev\/null|Operation not permitted|native_write_sandbox_denial/i.test(output)) {
    return "next_recovery_action: keep command goal; use project-local paths like .easycode/tmp or .easycode/reports; avoid /tmp and /dev/null; request bypass only with user approval."
  }
  if (call.name === "bash" && /JSON\.parse|Unexpected token|SyntaxError/i.test(output)) {
    return "next_recovery_action: keep requested scope; separate runner noise from machine JSON; parse project-local report or direct script output."
  }
  if (call.name === "bash" && /timed out|timeout/i.test(output)) {
    return "next_recovery_action: keep requested scope; use longer timeout or label any subset as diagnostic before full rerun."
  }
  return "next_recovery_action: inspect failure, preserve requested scope, choose smallest safe recovery."
}

type ProviderMetricsAccumulator = {
  provider: string
  model?: string
  pricing: CachePricing
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  totalTokens?: number
  reasoningTokens?: number
  providerElapsedMs: number
  firstResponseMs?: number
}

type ProviderMetricCall = {
  startedAt: number
  firstResponseMs?: number
}

function createProviderMetrics(provider: string, model?: string): ProviderMetricsAccumulator {
  return {
    provider,
    model,
    pricing: defaultCachePricing(),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    providerElapsedMs: 0,
  }
}

function startProviderMetricCall(metrics?: ProviderMetricsAccumulator): ProviderMetricCall | undefined {
  if (!metrics) return undefined
  metrics.calls += 1
  return { startedAt: Date.now() }
}

function observeProviderMetricEvent(metrics: ProviderMetricsAccumulator | undefined, call: ProviderMetricCall | undefined, event: ProviderEvent) {
  if (!metrics || !call) return
  if (event.type === "text_delta" && call.firstResponseMs === undefined) {
    call.firstResponseMs = Date.now() - call.startedAt
    metrics.firstResponseMs = metrics.firstResponseMs === undefined ? call.firstResponseMs : Math.min(metrics.firstResponseMs, call.firstResponseMs)
  }
  if (event.type !== "usage") return
  mergeProviderUsage(metrics, event)
}

function finishProviderMetricCall(metrics: ProviderMetricsAccumulator | undefined, call: ProviderMetricCall | undefined) {
  if (!metrics || !call) return
  metrics.providerElapsedMs += Date.now() - call.startedAt
}

function mergeProviderUsage(target: ProviderMetricsAccumulator, event: Extract<ProviderEvent, { type: "usage" }>) {
  target.inputTokens += event.inputTokens
  target.outputTokens += event.outputTokens
  target.cacheHitTokens += event.cacheHitTokens ?? 0
  target.cacheMissTokens += event.cacheMissTokens ?? Math.max(0, event.inputTokens - (event.cacheHitTokens ?? 0))
  target.totalTokens = (target.totalTokens ?? 0) + (event.totalTokens ?? event.inputTokens + event.outputTokens)
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (event.reasoningTokens ?? 0)
}

function finalizeProviderMetrics(metrics: ProviderMetricsAccumulator): ProviderRunMetrics {
  const hitRate = metrics.inputTokens === 0 ? 0 : metrics.cacheHitTokens / metrics.inputTokens
  const outputSeconds = metrics.providerElapsedMs / 1_000
  const outputTokensPerSecond = outputSeconds <= 0 || metrics.outputTokens === 0 ? undefined : metrics.outputTokens / outputSeconds
  return {
    provider: metrics.provider,
    model: metrics.model,
    calls: metrics.calls,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheHitTokens: metrics.cacheHitTokens,
    cacheMissTokens: metrics.cacheMissTokens,
    totalTokens: metrics.totalTokens,
    reasoningTokens: metrics.reasoningTokens,
    hitRate,
    providerElapsedMs: metrics.providerElapsedMs,
    firstResponseMs: metrics.firstResponseMs,
    outputTokensPerSecond,
    effectiveCost: metrics.cacheHitTokens * metrics.pricing.inputCacheHit + metrics.cacheMissTokens * metrics.pricing.inputCacheMiss + metrics.outputTokens * metrics.pricing.output,
    rates: metrics.pricing,
  }
}

function ledgerRecord(kind: LedgerKind, subject: string, value: string, status: LedgerStatus, turn: number, input: { scope?: LedgerScope; reason?: string; evidence?: LedgerRecord["evidence"] } = {}): LedgerRecord {
  return {
    id: `run_${kind}_${hashLedgerID(`${subject}\n${value}\n${JSON.stringify(input.scope ?? {})}`)}`,
    kind,
    subject,
    value,
    status,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    createdAtTurn: turn,
    updatedAtTurn: turn,
  }
}

function toolScopeFiles(call: ToolCall, result?: { metadata: Record<string, unknown> }) {
  const files = new Set<string>()
  collectFileRefs(call.input, files)
  collectFileRefs(result?.metadata.changed, files)
  return [...files]
}

function collectFileRefs(value: unknown, output: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|css|html|go|py|rs|toml|yaml|yml)/g)) {
      output.add(match[0].replaceAll("\\", "/").replace(/^\.\//, ""))
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileRefs(item, output)
    return
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectFileRefs(item, output)
  }
}

function hashLedgerID(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function assistantMessage(reasoningText: string, text: string) {
  const parts: MessagePart[] = []
  if (reasoningText) parts.push(reasoningPart(reasoningText))
  if (text) parts.push(textPart(text))
  return createMessage("assistant", parts.length > 0 ? parts : [textPart("")])
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

export function createRunner(input: { root: string; provider?: ProviderName; mode?: AgentMode; logger?: Logger; context?: ContextManagerLike; permission?: PermissionService; onTextDelta?: (text: string) => void; onEvent?: (event: RunUiEvent) => void; toolProgressIntervalMs?: number; settings?: SessionSettings }) {
  const settings = input.settings ?? defaultSessionSettings(input.provider ?? "fake")
  return new AgentRunner({ root: input.root, provider: createProvider(input.provider ?? settings.provider ?? "fake", { model: settings.model, thinking: settings.thinking, effort: settings.effort }), permission: input.permission ?? PermissionService.autoApprove(defaultPermissionRules(input.mode ?? "build")), logger: input.logger, context: input.context, onTextDelta: input.onTextDelta, onEvent: input.onEvent, toolProgressIntervalMs: input.toolProgressIntervalMs, settings })
}
