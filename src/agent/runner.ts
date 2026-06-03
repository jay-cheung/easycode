import { ContextManager, type ContextCompactionSnapshot, type ContextManagerLike, type LedgerRecord } from "../context"
import { createMessage, reasoningPart, textPart, userMessage, toolCallMessage, toolResultMessage, type AgentMode, type ImagePart, type Message, type MessagePart, type ProviderInputMessage, type ToolCall } from "../message"
import { defaultPermissionRules, PermissionService } from "../permission"
import { createProvider, ProviderError, StreamXmlFilter, textToolProtocolOutputToProviderEvents, type Provider, type ProviderName } from "../provider"
import { Sandbox } from "../sandbox"
import { SkillService, type SkillServiceLike } from "../skill"
import { InstructionService, type InstructionServiceLike } from "../instruction"
import { createBuiltinRegistry, type ToolDef, type ToolRegistryLike } from "../tool"
import { CliCodeNavigator } from "../tool/code-navigator"
import { createRunAspect, type RunAspect } from "../instrumentation"
import type { Logger } from "../logger"
import { BASE_COMPACT_PROMPT } from "../context/prompt"
import * as protocol from "./protocol"
import type { PermissionRule } from "../permission"
import { defaultSessionSettings, type SessionSettings } from "../settings"
import type { RunUiEvent } from "../ui/timeline"
import { createAgent } from "./protocol"
import type { Agent, AgentRunResult, AgentRunnerOptions } from "./types"
import { createProviderMetrics, finalizeProviderMetrics, finishProviderMetricCall, observeProviderMetricEvent, startProviderMetricCall, type ProviderMetricsAccumulator } from "./metrics"
import { ledgerRecord, toolScopeFiles } from "./ledger"

const defaultToolProgressIntervalMs = 10_000
const defaultProviderProgressIntervalMs = 10_000

type BackgroundAgentTask = {
  kind: "summary"
  id: number
  startedAt: number
  agent: Agent
  snapshot: ContextCompactionSnapshot
  promise: Promise<void>
}

type ProviderTurnResult = {
  text: string
  reasoningText: string
  toolCalls: ToolCall[]
  failureText?: string
  cancelledOutput?: string
}

type ProviderTurnInput = {
  agent: Agent
  prompt: string
  messages: Message[]
  providerMessages: ProviderInputMessage[]
  tools: ToolDef[]
  signal?: AbortSignal
  providerMetrics?: ProviderMetricsAccumulator
  emitDeltas?: boolean
  observeContextUsage?: boolean
}


export class AgentRunner {
  readonly root: string
  readonly provider: Provider
  readonly registry: ToolRegistryLike
  readonly permission: PermissionService
  readonly context: ContextManagerLike
  readonly skills: SkillServiceLike
  readonly instructions: InstructionServiceLike
  readonly sandbox: Sandbox
  readonly aspect: RunAspect
  readonly onTextDelta?: (text: string) => void
  readonly onEvent?: (event: RunUiEvent) => void
  readonly toolProgressIntervalMs: number
  readonly providerProgressIntervalMs: number
  readonly settings: SessionSettings
  readonly onBackgroundContextUpdate?: () => void | Promise<void>
  private summarySubagent: BackgroundAgentTask | undefined
  private nextSummarySubagentID = 1
  private hasProposedPlan: boolean

  constructor(options: AgentRunnerOptions) {
    this.root = options.root
    this.aspect = options.aspect ?? createRunAspect(options.logger)
    this.provider = this.aspect.instrumentProvider(options.provider)
    this.registry = this.aspect.instrumentRegistry(options.registry ?? createBuiltinRegistry())
    this.permission = options.permission ?? PermissionService.autoApprove(defaultPermissionRules("build"))
    this.context = this.aspect.instrumentContext(options.context ?? new ContextManager())
    this.hasProposedPlan = this.context.state.messages.some(
      (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && protocol.hasProposedPlanText(p.text))
    )
    this.skills = this.aspect.instrumentSkills(options.skills ?? new SkillService(options.root))
    this.instructions = options.instructions ?? new InstructionService(options.root)
    this.sandbox = options.sandbox ?? new Sandbox(options.root)
    this.onTextDelta = options.onTextDelta
    this.onEvent = options.onEvent
    this.toolProgressIntervalMs = options.toolProgressIntervalMs ?? defaultToolProgressIntervalMs
    this.providerProgressIntervalMs = options.providerProgressIntervalMs ?? defaultProviderProgressIntervalMs
    this.settings = options.settings ?? defaultSessionSettings(this.provider.name)
    this.onBackgroundContextUpdate = options.onBackgroundContextUpdate
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
    const instructions = await this.instructions.system()
    const skills = await this.skills.available()
    const selectedSkills = await this.selectedSkills()
    for (let step = 0; step < this.maxSteps; step += 1) {
      if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
      this.aspect.step(step + 1, this.maxSteps)
      try {
        await this.compactContext(providerMetrics)
      } catch (error) {
        if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
        throw error
      }
      if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
      const plan = this.context.planRequest({ step, agent, instructions, skills, selectedSkills, pendingSkillLoads: this.pendingSelectedSkills(selectedSkills), tools })
      const shouldCheckSummaryReadiness = usedTools.length > 0 && step >= explorationSummaryStep(this.maxSteps)
      const providerMessages = shouldCheckSummaryReadiness ? [...plan.providerMessages, explorationSummaryReadinessMessage(step + 1, this.maxSteps)] : plan.providerMessages
      const availableTools = shouldCheckSummaryReadiness ? [] : tools
      state = this.aspect.transition("streaming", { step: step + 1 })
      const turn = await this.runProviderTurn({
        agent,
        prompt,
        messages: this.context.state.messages,
        providerMessages,
        tools: availableTools,
        signal: input.signal,
        providerMetrics,
      })
      const currentReasoningTranscript = () => appendOutput(reasoningTranscript, turn.reasoningText)
      if (turn.cancelledOutput) return this.cancelledResult(currentReasoningTranscript(), usedTools, turn.cancelledOutput, providerMetrics)
      reasoningTranscript = currentReasoningTranscript()
      if (input.signal?.aborted) return this.cancelledResult(reasoningTranscript, usedTools, appendOutput(turn.text, "Run cancelled by user."), providerMetrics)
      if (turn.failureText) {
        const output = appendOutput(turn.text, turn.failureText)
        this.context.add(assistantMessage(reasoningTranscript, output))
        state = this.aspect.runFailed("provider_error", usedTools)
        this.emitRunDone("failed", providerMetrics)
        return { status: "failed", failureReason: "provider_error", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
      }
      if (turn.text) latestAssistantText = turn.text
      if (turn.toolCalls.length === 0) {
        const output = turn.text
        if (mode === "plan" && protocol.hasProposedPlanText(output)) this.hasProposedPlan = true
        this.context.add(assistantMessage(reasoningTranscript, output))
        state = this.aspect.transition("completed", { usedTools })
        this.emitRunDone("completed", providerMetrics)
        return { status: "completed", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
      }
      state = this.aspect.transition("tool_pending", { tools: turn.toolCalls.map((call) => call.name), callIDs: turn.toolCalls.map((call) => call.id) })
      this.context.add(toolCallMessage(turn.toolCalls))
      for (const toolCall of turn.toolCalls) {
        usedTools.push(toolCall.name)
        state = this.aspect.transition("tool_running", { tool: toolCall.name, callID: toolCall.id })
        const result = await this.runTool(toolCall, effectiveMode, input.signal)
        if (toolCall.name === "skill" && result.metadata.status === "succeeded") this.markSkillLoaded(toolCall.input)
        this.recordToolOutcome(toolCall, result, prompt)
        this.context.add(toolResultMessage({ callID: toolCall.id, toolName: toolCall.name, status: result.metadata.status === "succeeded" ? "succeeded" : result.metadata.status === "denied" ? "denied" : "failed", output: result.output, metadata: result.metadata }))
        this.onEvent?.({ type: "tool_result", callID: toolCall.id, toolName: toolCall.name, title: result.title, status: String(result.metadata.status ?? "failed"), output: result.output, durationMs: numericMetadata(result.metadata.durationMs) })
        if (input.signal?.aborted || result.metadata.cancelled === true) return this.cancelledResult(reasoningTranscript, usedTools, undefined, providerMetrics)
        if (effectiveMode === "plan" && toolCall.name === "plan_exit" && result.metadata.status === "succeeded") {
          const output = result.output
          const displayText = protocol.stripPlanTags(result.output)
          this.onEvent?.({ type: "text_delta", text: displayText })
          this.onTextDelta?.(displayText)
          this.hasProposedPlan = true
          this.context.add(assistantMessage(reasoningTranscript, output))
          state = this.aspect.transition("completed", { usedTools })
          this.emitRunDone("completed", providerMetrics)
          return { status: "completed", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
        }
      }
      state = this.aspect.transition("streaming", { nextStep: step + 2 })
    }
    const maxStepsText = runFailureText(`Stopped after maxSteps (${this.maxSteps}).`, "max_steps")
    const text = appendOutput(latestAssistantText, maxStepsText)
    this.onEvent?.({ type: "failure", text: maxStepsText })
    this.onTextDelta?.(maxStepsText)
    this.context.add(assistantMessage(reasoningTranscript, text))
    state = this.aspect.runFailed("max_steps", usedTools)
    this.emitRunDone("failed", providerMetrics)
    return { status: "failed", failureReason: "max_steps", text, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
  }

  private async runProviderTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    const textChunks: string[] = []
    const reasoningChunks: string[] = []
    const toolCalls: ToolCall[] = []
    const tools = input.agent.tools === "none" ? [] : input.tools
    const emitDeltas = input.emitDeltas ?? true
    const observeContextUsage = input.observeContextUsage ?? true
    let failureText: string | undefined
    const stopProviderProgress = this.startProviderProgressTimer()
    const metricCall = startProviderMetricCall(input.providerMetrics)
    if (input.providerMetrics && this.onEvent) {
      this.onEvent({ type: "provider_metrics", metrics: finalizeProviderMetrics(input.providerMetrics), interim: true })
    }
    const currentText = () => textChunks.join("")
    const currentReasoning = () => reasoningChunks.join("")
    const xmlFilter = new StreamXmlFilter()
    try {
      for await (const event of this.provider.stream({ mode: input.agent.mode, prompt: input.prompt, messages: input.messages, providerMessages: input.providerMessages, tools, signal: input.signal })) {
        observeProviderMetricEvent(input.providerMetrics, metricCall, event)
        if (event.type === "usage" && input.providerMetrics && this.onEvent) {
          this.onEvent({ type: "provider_metrics", metrics: finalizeProviderMetrics(input.providerMetrics), interim: true })
        }
        if (input.signal?.aborted) return { text: currentText(), reasoningText: currentReasoning(), toolCalls, cancelledOutput: appendOutput(currentText(), "Run cancelled by user.") }
        if (event.type === "reasoning_delta") {
          stopProviderProgress()
          reasoningChunks.push(event.text)
          if (emitDeltas) {
            this.onEvent?.({ type: "reasoning_delta", text: event.text })
            this.onTextDelta?.(event.text)
          }
        }
        if (event.type === "text_delta") {
          stopProviderProgress()
          textChunks.push(event.text)
          if (emitDeltas) {
            const safeText = xmlFilter.feed(event.text)
            if (safeText) {
              this.onEvent?.({ type: "text_delta", text: safeText })
              this.onTextDelta?.(safeText)
            }
          }
        }
        if (event.type === "failure") {
          stopProviderProgress()
          failureText = runFailureText(event.error.output || event.error.message, "provider_error")
          if (emitDeltas) {
            this.onEvent?.({ type: "failure", text: failureText })
            this.onTextDelta?.(failureText)
          }
        }
        if (event.type === "tool_call") {
          stopProviderProgress()
          toolCalls.push(event.call)
          if (emitDeltas) this.onEvent?.({ type: "tool_call", call: event.call })
        }
        if (event.type === "usage" && observeContextUsage) this.context.observeUsage(event)
      }
      const leftover = xmlFilter.flush()
      if (emitDeltas && leftover) {
        this.onEvent?.({ type: "text_delta", text: leftover })
        this.onTextDelta?.(leftover)
      }
      return this.extractFallbackToolCalls({ text: currentText(), reasoningText: currentReasoning(), toolCalls, failureText }, emitDeltas)
    } catch (error) {
      if (input.signal?.aborted) return { text: currentText(), reasoningText: currentReasoning(), toolCalls, cancelledOutput: appendOutput(currentText(), "Run cancelled by user.") }
      if (!(error instanceof ProviderError)) throw error
      const failureText = runFailureText(providerFailureText(error), "provider_error")
      if (emitDeltas) this.onEvent?.({ type: "failure", text: failureText })
      return { text: currentText(), reasoningText: currentReasoning(), toolCalls, failureText }
    } finally {
      finishProviderMetricCall(input.providerMetrics, metricCall)
      stopProviderProgress()
      if (input.providerMetrics && this.onEvent) {
        this.onEvent({ type: "provider_metrics", metrics: finalizeProviderMetrics(input.providerMetrics), interim: true })
      }
    }
  }

  private extractFallbackToolCalls(result: ProviderTurnResult, emitDeltas: boolean): ProviderTurnResult {
    if (result.toolCalls.length > 0 || !result.text || result.failureText || result.cancelledOutput) return result
    const events = textToolProtocolOutputToProviderEvents(result.text)
    const extractedCalls = events.filter((e): e is { type: "tool_call"; call: ToolCall } => e.type === "tool_call").map((e) => e.call)
    if (extractedCalls.length === 0) return result
    const textParts = events.filter((e): e is { type: "text_delta"; text: string } => e.type === "text_delta").map((e) => e.text)
    if (emitDeltas) {
      for (const call of extractedCalls) this.onEvent?.({ type: "tool_call", call })
    }
    return { ...result, text: textParts.join(""), toolCalls: extractedCalls }
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
        context: this.context,
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

  private async compactContext(providerMetrics?: ProviderMetricsAccumulator) {
    if (this.summarySubagent || !this.context.needsCompaction()) return
    const snapshot = this.context.compactionSnapshot()
    if (!snapshot) return
    this.startSummarySubagent(snapshot, providerMetrics)
  }

  async waitForSummarySubagent() {
    await this.summarySubagent?.promise
  }

  private startSummarySubagent(snapshot: ContextCompactionSnapshot, providerMetrics?: ProviderMetricsAccumulator) {
    const task: BackgroundAgentTask = {
      kind: "summary",
      id: this.nextSummarySubagentID++,
      startedAt: Date.now(),
      agent: createAgent("summary"),
      snapshot,
      promise: Promise.resolve(),
    }
    this.summarySubagent = task
    this.onEvent?.({ type: "context_compaction", status: "started", inputMessages: snapshot.providerMessages.length })
    task.promise = this.runSummarySubagent(task, providerMetrics)
    void task.promise
  }

  private async runSummarySubagent(task: BackgroundAgentTask, providerMetrics?: ProviderMetricsAccumulator) {
    const providerMessages = [
      { role: "system" as const, content: `${task.agent.systemPrompt}\n\nMode: ${task.agent.mode}\nTools: none` },
      { role: "user" as const, content: compactPrompt(task.snapshot.providerMessages) },
    ]
    try {
      const turn = await this.runProviderTurn({
        agent: task.agent,
        prompt: "Summarize conversation for context compaction",
        messages: [],
        providerMessages,
        tools: [],
        providerMetrics,
        emitDeltas: false,
        observeContextUsage: false,
      })
      if (turn.failureText) throw new Error(turn.failureText)
      const extracted = extractSummary(turn.text)
      const compacted = this.context.compactSnapshot(extracted, task.snapshot)
      if (compacted) {
        await this.onBackgroundContextUpdate?.()
        this.onEvent?.({ type: "context_compaction", status: "completed", elapsedMs: Date.now() - task.startedAt, summaryChars: extracted.length })
      }
    } catch (error) {
      this.onEvent?.({ type: "context_compaction", status: "failed", elapsedMs: Date.now() - task.startedAt, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.summarySubagent?.id === task.id) this.summarySubagent = undefined
    }
  }

  private emitRunDone(status: string, providerMetrics: ProviderMetricsAccumulator | undefined) {
    if (providerMetrics && providerMetrics.calls > 0) this.onEvent?.({ type: "provider_metrics", metrics: finalizeProviderMetrics(providerMetrics) })
    this.onEvent?.({ type: "run_done", status })
  }

  private async selectedSkills() {
    const selected = this.settings.selectedSkills ?? []
    if (selected.length === 0) return []
    const skills = await this.skills.available()
    const nameSet = new Set(selected)
    const idSet = new Set(selected)
    // Match by id first, then by name (backward compat with old name-based settings)
    const matched = skills.filter((s) => idSet.has(s.id) || nameSet.has(s.name))
    // Load full content for matched skills
    return (await Promise.all(matched.map((s) => this.skills.load(s.id)))).filter((s): s is NonNullable<typeof s> => Boolean(s))
  }

  private pendingSelectedSkills(selectedSkills: Awaited<ReturnType<AgentRunner["selectedSkills"]>>) {
    const pending = new Set(this.settings.pendingSkillLoads ?? [])
    if (pending.size === 0) return []
    return selectedSkills.filter((skill) => pending.has(skill.id) || pending.has(skill.name))
  }

  private markSkillLoaded(input: unknown) {
    if (!input || typeof input !== "object") return
    const name = (input as { name?: unknown }).name
    if (typeof name !== "string") return
    this.settings.pendingSkillLoads = (this.settings.pendingSkillLoads ?? []).filter((s) => s !== name)
  }

  private effectiveMode(prompt: string, mode: AgentMode): AgentMode {
    if (mode !== "plan") return mode
    if (!isPlanApproval(prompt)) return mode
    return this.hasProposedPlan ? "build" : mode
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
        ledgerRecord("constraint", "efficient_tool_usage", "do not repeatedly call read or search on the same path/query; reuse previous results and trust your findings.", "current", turn),
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
      let relevantFiles: number | undefined

      if (prompt) {
        const filteredMap = await new CliCodeNavigator(this.sandbox, { signal }).repoMap({ query: prompt })
        if (filteredMap.entries.length > 0) {
          relevantFiles = filteredMap.entries.length
          checkpointText += ` (query-targeted subset containing ${filteredMap.entries.length} relevant files)`
          dynamicMapRecord = ledgerRecord(
            "checkpoint",
            "query_targeted_repo_map",
            `query-targeted repo_map prepared: ${filteredMap.entries.length} relevant files. Use repo_map with query="${truncateForLedger(prompt, 80)}" to fetch the current skeleton instead of reading whole files.`,
            "current",
            turn,
            { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }
          )
        }
      }
      this.onEvent?.({ type: "repo_map", status: "succeeded", cacheHit: map.cache.hit, files: map.entries.length, relevantFiles, cachePath: map.cache.path })

      this.context.updateLedger({
        current: [
          ledgerRecord("checkpoint", "repo_map_cache", checkpointText, "current", turn, { evidence: { source: "assistant" }, scope: { files: [map.cache.path], topics: ["repo_map", "code_navigation"] } }),
          ledgerRecord("constraint", "code_navigation_entrypoint", "repo_map cache is prewarmed at conversation start; prefer repo_map, find_definition, rg_search, and read_lines before grep or full-file read.", "current", turn, { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }),
          ...(dynamicMapRecord ? [dynamicMapRecord] : []),
        ],
      })
    } catch (error) {
      this.onEvent?.({ type: "repo_map", status: "failed", error: error instanceof Error ? error.message : String(error) })
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
      const toolEvidence = { source: "tool" as const }
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
    const failureEvidence = { source: "tool" as const }
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

function explorationSummaryStep(maxSteps: number) {
  const defaultExplorationSteps = 12;
  return Math.min(defaultExplorationSteps, Math.ceil(maxSteps * 0.7))
}

function explorationSummaryReadinessMessage(step: number, maxSteps: number) {
  return {
    role: "user" as const,
    content: [
      `Exploration checkpoint reached at step ${step}/${maxSteps}.`,
      "Before calling another tool, decide whether the information already gathered is enough to answer the user's request.",
      "If it is enough, stop exploring and provide the summary now.",
      "If it is not enough, do not call tools. Ask the user whether to continue exploring or summarize with the current evidence.",
    ].join("\n"),
  }
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
  // Remove common punctuation and whitespace for more robust matching
  const cleaned = text.replace(/[.!?，。！？、\s]+$/g, "").trim()
  return /^(执行吧|执行|确认|接受|同意|继续|开始|approve|accepted|approved|execute|go ahead|yes|yeah|yep|y|ok|okay|do it|let's go|sure|proceed)$/i.test(cleaned)
}

export function createRunner(input: { root: string; provider?: ProviderName; mode?: AgentMode; logger?: Logger; context?: ContextManagerLike; permission?: PermissionService; onTextDelta?: (text: string) => void; onEvent?: (event: RunUiEvent) => void; onBackgroundContextUpdate?: () => void | Promise<void>; toolProgressIntervalMs?: number; settings?: SessionSettings }) {
  const settings = input.settings ?? defaultSessionSettings(input.provider ?? "fake")
  return new AgentRunner({ root: input.root, provider: createProvider(input.provider ?? settings.provider ?? "fake", { model: settings.model, thinking: settings.thinking, effort: settings.effort }), permission: input.permission ?? PermissionService.autoApprove(defaultPermissionRules(input.mode ?? "build")), logger: input.logger, context: input.context, onTextDelta: input.onTextDelta, onEvent: input.onEvent, onBackgroundContextUpdate: input.onBackgroundContextUpdate, toolProgressIntervalMs: input.toolProgressIntervalMs, settings })
}
