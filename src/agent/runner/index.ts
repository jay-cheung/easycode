import path from "node:path"
import { ContextManager, type ContextCompactionSnapshot, type ContextManagerLike } from "../../context"
import { Message, canonicalizeAssistantHistory, createID, textMessage, userMessage, toolCallMessage, toolResultMessage, type AgentMode, type ImagePart, type ToolCall } from "../../message"
import { defaultPermissionRules, defaultSubagentPermissionRules, PermissionService } from "../../permission"
import { createProvider, type Provider, type ProviderName } from "../../provider"
import { Sandbox } from "../../sandbox"
import { SkillService, type SkillArtifact, type SkillServiceLike, type SkillInfo } from "../../skill"
import { InstructionService, type InstructionServiceLike, type InstructionInfo } from "../../instruction"
import { createBuiltinRegistry, type ToolRegistryLike, type ToolDef, type ToolResult } from "../../tool"
import { createRunAspect, type RunAspect } from "../../instrumentation"
import { createLogger, emitLog, type Logger } from "../../logger"
import { ProjectMemoryStore, renderProjectMemoryRecall, shouldAutoRecallProjectMemory, type ProjectMemoryRecord } from "../../memory"
import * as protocol from "../protocol"
import { defaultSessionSettings, type SessionSettings } from "../../settings"
import type { RunUiEvent } from "../../ui/timeline"
import { createAgent } from "../protocol"
import type { Agent, AgentRunResult, AgentRunnerOptions } from "../types"
import { createProviderMetrics, finalizeProviderMetrics, type ProviderMetricsAccumulator } from "../metrics"
import { evaluateHypothesisTurn, type ActiveHypothesis, type HypothesisViolation } from "../hypothesis"
import { emitProviderTurnEvents, runProviderTurnStream, type ProviderTurnInput, type ProviderTurnResult } from "./provider-turn"
import { createSummaryTask, runSummarySubagentTask, type BackgroundAgentTask } from "./summary-subagent"
import { createDerivedSubagentProvider, resolveSubagentRoute } from "../subagent-routing"
import { blockedInternalActionToolResult, buildSubagentHandoffResult, budgetDeniedToolResult, createSubagentTaskState, filterToolsForAgent, formatSubagentResult, isCoordinatorOnlyTool, maxSubagentInvocationsPerRun, maxSubagentTurnsPerRun, noteSubagentBlockedAction, noteSubagentToolResult, noteSubagentTurn, parseSubagentRequest, roleInvocationLimit, suggestedCoordinatorSubagentRole, type SubagentAssignedStep, type SubagentBudgetSnapshot, type SubagentExecutionResult, type SubagentRequest, type SubagentTaskState } from "../subagent-runtime"
import { refreshRepoMapCache } from "./repo-map-refresh"
import { emitToolResultEvent, recordToolOutcome as recordToolOutcomeSideEffect, runToolCall } from "./tool-execution"
import { activeHypothesisFromLedger, activeHypothesisMessages, compactLine, hypothesisCorrectionMessage, recordActiveSkillState, recordHypothesisViolationState, recordRunIntentState, truncateForLedger, updateActiveHypothesisState } from "./hypothesis-state"
import { effectiveModeForPrompt, markSkillLoadedInSettings, pendingSelectedSkillsForSettings, permissionServiceForMode, selectedSkillsForSettings } from "./runner-support"
import { ledgerRecord } from "../ledger"
import { runValidatedProviderTurnLoop } from "./validated-provider-turn"
import { appendOutput, assistantMessage, compactPrompt, explorationSummaryReadinessMessage, explorationSummaryStep, ledgerValue, summaryLanguageHint } from "./runner-helpers"
import { createCancelledRunResult } from "./runner-outcomes"
import { prepareProviderTurnRequest } from "./runner-turn-prep"
import { runFailureText } from "./failure-policy"
import { emitPlanExitText, emitRunDoneEvent } from "./runner-events"
import { isPlanApprovalPrompt, isPlanRevisionPrompt, loadStructuredPlanState, renderPlanToMarkdown, type ExecutionPlan, type PlanStep } from "../../plans"
import { parseExecutionPlanFromResponse, Planner, Replanner, PlanTracker } from "../planner"
import { defaultToolProgressIntervalMs, defaultProviderProgressIntervalMs, maxAutoSkillArtifactInspections, autoInspectFileExtensions, autoInspectFileBasenames, autoInspectIgnoredBasenames, autoInspectIgnoredDirectories, autoRecallMemoryKinds, maxAutoRecalledMemoryRecords } from "./constants"
import { createSubagentLogger, withSubagentLogContext, buildSubagentTaskPrompt, autoSkillArtifactCalls, memoryLedgerValue, memoryScopeToLedger } from "./helpers"
import type { AgentRunState, SubagentRole } from "../types"

const coordinatorDelegationGateBypassProviders = new Set(["fake", "test-provider", "simulated"])
const subagentRoles: SubagentRole[] = ["summary", "explorer", "reviewer", "debugger", "tester", "docs_researcher"]

type SubagentRoleUsage = {
  started: number
  succeeded: number
  failed: number
  handoff: number
  turnsUsed: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

type SubagentRunUsage = {
  startedInvocations: number
  usedTurns: number
  reservedTurns: number
  byRole: Record<SubagentRole, number>
  statsByRole: Record<SubagentRole, SubagentRoleUsage>
}

function createSubagentRoleUsage(): SubagentRoleUsage {
  return { started: 0, succeeded: 0, failed: 0, handoff: 0, turnsUsed: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
}

function createSubagentRunUsage(): SubagentRunUsage {
  return {
    startedInvocations: 0,
    usedTurns: 0,
    reservedTurns: 0,
    byRole: Object.fromEntries(subagentRoles.map((role) => [role, 0])) as Record<SubagentRole, number>,
    statsByRole: Object.fromEntries(subagentRoles.map((role) => [role, createSubagentRoleUsage()])) as Record<SubagentRole, SubagentRoleUsage>,
  }
}

function shouldEnforceCoordinatorDelegation(provider: Provider) {
  return !coordinatorDelegationGateBypassProviders.has(provider.name)
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
  readonly logger?: Logger
  readonly subagentLogger?: Logger
  readonly subagentAspect: RunAspect
  readonly subagentRegistry: ToolRegistryLike
  readonly subagentSkills: SkillServiceLike
  readonly subagentSandbox: Sandbox
  readonly onTextDelta?: (text: string) => void
  readonly onEvent?: (event: RunUiEvent) => void
  readonly toolProgressIntervalMs: number
  readonly providerProgressIntervalMs: number
  readonly settings: SessionSettings
  readonly onBackgroundContextUpdate?: () => void | Promise<void>
  readonly sessionId?: string
  readonly forcePlanning?: boolean
  private summarySubagent: BackgroundAgentTask | undefined
  private nextSummarySubagentID = 1
  private nextSubagentRequestID = 1
  private hasProposedPlan: boolean
  private evidenceRevision = 0
  private activeHypothesis: ActiveHypothesis | undefined
  private activeForegroundSubagentRequestID: number | undefined
  private subagentUsage = createSubagentRunUsage()

  constructor(options: AgentRunnerOptions) {
    this.root = options.root
    this.sessionId = options.sessionId
    this.forcePlanning = options.forcePlanning
    this.logger = options.logger
    this.aspect = options.aspect ?? createRunAspect(options.logger)
    this.provider = this.aspect.instrumentProvider(options.provider)
    this.registry = this.aspect.instrumentRegistry(options.registry ?? createBuiltinRegistry())
    this.subagentLogger = createSubagentLogger(options.root, options.sessionId, options.logger)
    this.subagentAspect = createRunAspect(this.subagentLogger)
    this.subagentRegistry = this.subagentAspect.instrumentRegistry(createBuiltinRegistry())
    this.permission = options.permission ?? PermissionService.autoApprove(defaultPermissionRules("build"))
    this.context = this.aspect.instrumentContext(options.context ?? new ContextManager())
    this.hasProposedPlan = this.context.state.messages.some(
      (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && protocol.hasProposedPlanText(p.text))
    )
    this.skills = this.aspect.instrumentSkills(options.skills ?? new SkillService(options.root))
    this.instructions = options.instructions ?? new InstructionService(options.root)
    this.sandbox = options.sandbox ?? new Sandbox(options.root)
    this.subagentSkills = this.subagentAspect.instrumentSkills(new SkillService(options.root))
    this.subagentSandbox = new Sandbox(options.root)
    this.onTextDelta = options.onTextDelta
    this.onEvent = options.onEvent
    this.toolProgressIntervalMs = options.toolProgressIntervalMs ?? defaultToolProgressIntervalMs
    this.providerProgressIntervalMs = options.providerProgressIntervalMs ?? defaultProviderProgressIntervalMs
    this.settings = options.settings ?? defaultSessionSettings(this.provider.name)
    this.onBackgroundContextUpdate = options.onBackgroundContextUpdate
    this.activeHypothesis = activeHypothesisFromLedger(this.context.state.ledger)
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
    this.subagentUsage = createSubagentRunUsage()
    const prep = await this.prepareRun(prompt, mode, input)
    if (prep.aborted) {
      return this.cancelledResult("", prep.usedTools, undefined, prep.providerMetrics)
    }
    if (prep.earlyExitResult) {
      return prep.earlyExitResult
    }

    let reasoningTranscript = ""
    let latestAssistantText = ""
    let state = prep.state
    let runResult: AgentRunResult | undefined = undefined

    for (let step = 0; step < this.maxSteps; step += 1) {
      const stepResult = await this.runStep(
        step,
        prompt,
        prep.effectiveMode,
        prep.requiresProposedPlan,
        prep.agent,
        prep.tools,
        prep.instructions,
        prep.skills,
        prep.selectedSkills,
        prep.usedTools,
        reasoningTranscript,
        latestAssistantText,
        state,
        prep.providerMetrics,
        input
      )

      if (stepResult.action === "cancel") {
        runResult = this.cancelledResult(stepResult.reasoningTranscript ?? reasoningTranscript, prep.usedTools, stepResult.output, prep.providerMetrics)
        break
      }

      if (stepResult.action === "exit") {
        runResult = stepResult.result
        break
      }

      reasoningTranscript = stepResult.reasoningTranscript
      latestAssistantText = stepResult.latestAssistantText
      state = stepResult.state
    }

    if (!runResult) {
      const maxStepsText = runFailureText(`Stopped after maxSteps (${this.maxSteps}).`, "max_steps")
      const text = appendOutput(latestAssistantText, maxStepsText)
      this.onEvent?.({ type: "failure", text: maxStepsText })
      this.onTextDelta?.(maxStepsText)
      this.context.add(assistantMessage(reasoningTranscript, text))
      state = this.aspect.runFailed("max_steps", prep.usedTools)
      this.emitRunDone("failed", prep.providerMetrics)
      runResult = { status: "failed", failureReason: "max_steps", text, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools: prep.usedTools, state }
    }

    if (runResult.status === "completed") {
      const latestLedger = this.context.state.ledger
      const planIdRecord = latestLedger?.current.find(r => r.subject === "current_plan_id" && r.status === "current")
      if (planIdRecord) {
        const planId = planIdRecord.value
        const sessionId = this.sessionId || "default"
        const currentPlanState = await loadStructuredPlanState(this.root, sessionId, planId)
        if (currentPlanState && (currentPlanState.checkpoint.status === "draft" || currentPlanState.checkpoint.status === "blocked")) {
          if (!protocol.hasProposedPlanText(runResult.text)) {
            const planMarkdown = renderPlanToMarkdown(currentPlanState.plan)
            const updatedText = appendOutput(runResult.text, planMarkdown)
            
            const displayText = protocol.stripPlanTags(planMarkdown)
            emitPlanExitText(this.onEvent, this.onTextDelta, displayText)

            const lastMsg = this.context.state.messages.at(-1)
            if (lastMsg && lastMsg.role === "assistant") {
              const reasoningPart = lastMsg.parts.find((part) => part.type === "reasoning")
              const textPart = lastMsg.parts.find(p => p.type === "text")
              if (textPart) {
                const canonical = canonicalizeAssistantHistory(reasoningPart?.type === "reasoning" ? reasoningPart.text : "", updatedText)
                if (reasoningPart?.type === "reasoning") reasoningPart.text = canonical.reasoningText
                textPart.text = canonical.text
              }
            }

            runResult = {
              ...runResult,
              text: updatedText,
            }
          }
        }
      }
    }

    this.emitSubagentUsageSummary()
    return runResult
  }

  private async prepareRun(
    prompt: string,
    mode: AgentMode,
    input: { images?: ImagePart[]; signal?: AbortSignal }
  ): Promise<{
    aborted: boolean
    earlyExitResult?: AgentRunResult
    effectiveMode: AgentMode
    requiresProposedPlan: boolean
    agent: Agent
    usedTools: string[]
    providerMetrics: ProviderMetricsAccumulator
    state: AgentRunState
    tools: ToolDef[]
    instructions: InstructionInfo[]
    skills: SkillInfo[]
    selectedSkills: SkillInfo[]
  }> {
    const ledger = this.context.state.ledger
    const planIdRecord = ledger?.current.find(r => r.subject === "current_plan_id" && r.status === "current")
    let resolvedMode = mode
    if (this.forcePlanning && !planIdRecord) {
      resolvedMode = "plan"
    }
    let activePlanState = undefined
    let earlyExitResult: AgentRunResult | undefined = undefined

    const providerMetrics = createProviderMetrics(this.provider.name, this.provider.model, { source: "main" })
    const usedTools: string[] = []
    
    if (planIdRecord) {
      resolvedMode = "build"
      const planId = planIdRecord.value
      const sessionId = this.sessionId || "default"
      activePlanState = await loadStructuredPlanState(this.root, sessionId, planId)
      if (activePlanState) {
        if (activePlanState.checkpoint.status === "draft" || activePlanState.checkpoint.status === "blocked") {
          resolvedMode = "plan"
        }

        const isApproval = isPlanApprovalPrompt(prompt)
        const isDraft = activePlanState.checkpoint.status === "draft"
        const isRevision = isPlanRevisionPrompt(prompt)

        if (isRevision) {
          try {
            const newPlan = await Replanner.replan(
              prompt,
              activePlanState.plan,
              activePlanState.checkpoint.stepStatuses,
              activePlanState.checkpoint.currentStepId ?? "",
              "User changed scope/objective",
              this.provider
            )
            activePlanState = await PlanTracker.activatePlan(this.context, this.root, sessionId, newPlan, {
              stepStatuses: activePlanState.checkpoint.stepStatuses,
              currentStepId: activePlanState.checkpoint.currentStepId,
              status: "draft",
              lastReplanReason: "scope_change",
            })

            const planMarkdown = renderPlanToMarkdown(newPlan)
            const displayText = protocol.stripPlanTags(planMarkdown)
            emitPlanExitText(this.onEvent, this.onTextDelta, displayText)
            this.hasProposedPlan = true
            this.context.add(assistantMessage("", planMarkdown))
            const state = this.aspect.transition("completed", { usedTools: [] })
            this.emitRunDone("completed", providerMetrics)

            earlyExitResult = {
              status: "completed",
              text: planMarkdown,
              reasoning: "",
              messages: this.context.state.messages,
              usedTools: [],
              state
            }
          } catch (replanError) {
            activePlanState = await PlanTracker.activatePlan(this.context, this.root, sessionId, activePlanState.plan, {
              ...activePlanState.checkpoint,
              status: "blocked",
              blocker: `Plan revision failed: ${replanError instanceof Error ? replanError.message : String(replanError)}`,
              lastReplanReason: "scope_change",
            })
            this.onEvent?.({
              type: "failure",
              text: `Failed to revise plan: ${replanError instanceof Error ? replanError.message : String(replanError)}`
            })
          }
        } else if (isApproval && activePlanState.checkpoint.currentStepId) {
          const currentStatus = activePlanState.checkpoint.stepStatuses[activePlanState.checkpoint.currentStepId] ?? "pending"
          if (currentStatus === "pending" || isDraft) {
            activePlanState = await PlanTracker.activatePlan(this.context, this.root, sessionId, activePlanState.plan, {
              ...activePlanState.checkpoint,
              stepStatuses: { ...activePlanState.checkpoint.stepStatuses, [activePlanState.checkpoint.currentStepId]: "running" },
              status: "running",
            })
            resolvedMode = "build"
          }
        }
      }
    }

    const effectiveMode = this.effectiveMode(prompt, resolvedMode)
    const requiresProposedPlan = resolvedMode === "plan"
    const agent = { ...createAgent(effectiveMode), mode: requiresProposedPlan ? "plan" as const : effectiveMode }
    const state = this.aspect.transition("preparing", { mode: effectiveMode, requestedMode: mode, provider: this.provider.name })
    this.onEvent?.({ type: "run_start", mode: effectiveMode, provider: this.provider.name, model: this.provider.model })
    this.context.add(userMessage(prompt, input.images ?? []))
    this.noteExternalEvidence()
    this.recordRunIntent(prompt)
    await this.maybeRecallProjectMemory(prompt)
    await this.refreshRepoMap(input.signal, prompt)
    
    if (input.signal?.aborted) {
      return { aborted: true, earlyExitResult, effectiveMode, requiresProposedPlan, agent, usedTools, providerMetrics, state, tools: [], instructions: [], skills: [], selectedSkills: [] }
    }
    
    const tools = filterToolsForAgent(this.registry.list(effectiveMode), { role: agent.role, depth: agent.depth ?? 0 })
    const instructions = await this.instructions.system()
    const skills = await this.skills.available()
    const selectedSkills = await this.selectedSkills()
    this.recordActiveSkills(selectedSkills)

    return {
      aborted: false,
      earlyExitResult,
      effectiveMode,
      requiresProposedPlan,
      agent,
      usedTools,
      providerMetrics,
      state,
      tools,
      instructions,
      skills,
      selectedSkills
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
    effectiveMode: AgentMode,
    signal: AbortSignal | undefined,
    usedTools: string[],
    prompt: string,
    selectedSkills: SkillInfo[],
    reasoningTranscript: string,
    providerMetrics: ProviderMetricsAccumulator,
  ): Promise<{ action: "exit"; result: AgentRunResult } | { action: "cancel" } | { action: "continue"; state: AgentRunState }> {
    usedTools.push(toolCall.name)
    let state = this.aspect.transition("tool_running", { tool: toolCall.name, callID: toolCall.id })
    const result = toolCall.name === "delegate_subagent"
      ? await this.executeDelegateSubagentToolCall(toolCall, signal)
      : await runToolCall({
        registry: this.registry,
        sandbox: this.sandbox,
        permission: this.permissionFor(effectiveMode),
        permissionFor: (mode) => this.permissionFor(mode),
        skills: this.skills,
        context: this.context,
        onEvent: this.onEvent,
        toolProgressIntervalMs: this.toolProgressIntervalMs,
      }, toolCall, effectiveMode, signal)
    
    if (toolCall.name === "skill" && result.metadata.status === "succeeded") {
      this.markSkillLoaded(toolCall.input)
      this.recordActiveSkills(selectedSkills)
    }
    
    this.recordToolOutcome(toolCall, result, prompt)
    this.context.add(toolResultMessage({
      callID: toolCall.id,
      toolName: toolCall.name,
      status: result.metadata.status === "succeeded" ? "succeeded" : result.metadata.status === "denied" ? "denied" : "failed",
      output: result.output,
      metadata: result.metadata,
    }))
    
    this.noteExternalEvidence()
    emitToolResultEvent({ onEvent: this.onEvent }, toolCall, result)
    
    if (toolCall.name === "skill" && result.metadata.status === "succeeded") {
      await this.autoInspectSkillArtifacts(result, effectiveMode, signal, prompt, usedTools)
    }
    
    if (signal?.aborted || result.metadata.cancelled === true) {
      return { action: "cancel" }
    }
    
    if (toolCall.name === "plan_step_fail") {
      const failedStepId = result.metadata.failedStepId as string
      const failReason = result.metadata.reason as string
      const latestLedger2 = this.context.state.ledger
      const planIdRec = latestLedger2?.current.find(r => r.subject === "current_plan_id" && r.status === "current")
      if (planIdRec) {
        const planId = planIdRec.value
        const sessionId = this.sessionId || "default"
        const currentPlanState = await loadStructuredPlanState(this.root, sessionId, planId)
        if (currentPlanState) {
          const stepStatuses = { ...currentPlanState.checkpoint.stepStatuses, [failedStepId]: "failed" as const }
          try {
            const newPlan = await Replanner.replan(
              prompt,
              currentPlanState.plan,
              stepStatuses,
              failedStepId,
              failReason,
              this.provider
            )
            await PlanTracker.activatePlan(this.context, this.root, sessionId, newPlan, {
              stepStatuses,
              currentStepId: currentPlanState.checkpoint.currentStepId,
              status: "running",
              lastReplanReason: "tool_failure",
            })
          } catch (replanError) {
            await PlanTracker.activatePlan(this.context, this.root, sessionId, currentPlanState.plan, {
              ...currentPlanState.checkpoint,
              stepStatuses,
              status: "blocked",
              blocker: `Replanning failed: ${replanError instanceof Error ? replanError.message : String(replanError)}`,
              lastReplanReason: "tool_failure",
            })
            this.onEvent?.({
              type: "failure",
              text: `Replanning failed: ${replanError instanceof Error ? replanError.message : String(replanError)}`
            })
          }
        }
      }
    }
    
    if (toolCall.name === "plan_exit" && result.metadata.status === "succeeded") {
      let output = result.output
      try {
        const planMarkdown = protocol.stripPlanTags(result.output)
        // Try direct JSON extraction first (avoids a second LLM call).
        // The system prompt instructs the LLM to include a JSON code block.
        let planJson: ExecutionPlan
        try {
          planJson = parseExecutionPlanFromResponse(planMarkdown)
        } catch {
          // Fall back to LLM-based markdown-to-JSON parsing when no JSON block is found
          planJson = await Planner.generateStructuredPlan(prompt, planMarkdown, this.provider)
        }
        const sessionId = this.sessionId || "default"
        await PlanTracker.activatePlan(this.context, this.root, sessionId, planJson, { status: "draft" })
        output = renderPlanToMarkdown(planJson)
      } catch {
        /* keep markdown-only plan output when structured parsing fails */
      }

      const displayText = protocol.stripPlanTags(output)
      emitPlanExitText(this.onEvent, this.onTextDelta, displayText)
      this.hasProposedPlan = true
      this.context.add(assistantMessage(reasoningTranscript, output))
      state = this.aspect.transition("completed", { usedTools })
      this.emitRunDone("completed", providerMetrics)
      return {
        action: "exit",
        result: { status: "completed", text: output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
      }
    }

    if (toolCall.name === "plan_step_complete" && result.metadata.status === "succeeded" && result.metadata.planCompleted === true) {
      state = this.aspect.transition("completed", { usedTools })
      this.emitRunDone("completed", providerMetrics)
      return {
        action: "exit",
        result: { status: "completed", text: result.output, reasoning: reasoningTranscript, messages: this.context.state.messages, usedTools, state }
      }
    }
    
    return { action: "continue", state }
  }

  private async runStep(
    step: number,
    prompt: string,
    effectiveMode: AgentMode,
    requiresProposedPlan: boolean,
    agent: Agent,
    tools: ToolDef[],
    instructions: InstructionInfo[],
    skills: SkillInfo[],
    selectedSkills: SkillInfo[],
    usedTools: string[],
    reasoningTranscript: string,
    latestAssistantText: string,
    state: AgentRunState,
    providerMetrics: ProviderMetricsAccumulator,
    input: { images?: ImagePart[]; signal?: AbortSignal },
  ): Promise<{ action: "exit"; result: AgentRunResult } | { action: "cancel"; output?: string; reasoningTranscript?: string } | { action: "continue"; reasoningTranscript: string; latestAssistantText: string; state: AgentRunState }> {
    if (input.signal?.aborted) return { action: "cancel", reasoningTranscript }
    this.aspect.step(step + 1, this.maxSteps)
    try {
      await this.compactContext()
    } catch (error) {
      if (input.signal?.aborted) return { action: "cancel", reasoningTranscript }
      throw error
    }
    if (input.signal?.aborted) return { action: "cancel", reasoningTranscript }

    let activeHypothesisMsgs = this.activeHypothesisMessages()
    let activePlanStep: PlanStep | undefined
    const latestLedger = this.context.state.ledger
    const activePlanIdRec = latestLedger?.current.find(r => r.subject === "current_plan_id" && r.status === "current")
    if (activePlanIdRec) {
      const planId = activePlanIdRec.value
      const sessionId = this.sessionId || "default"
      const currentPlanState = await loadStructuredPlanState(this.root, sessionId, planId)
      const stepId = currentPlanState?.checkpoint.status === "running" ? currentPlanState?.checkpoint.currentStepId : undefined
      if (currentPlanState && stepId) {
        const s = currentPlanState.plan.steps.find(stepItem => stepItem.id === stepId)
        if (s) {
          activePlanStep = s
          activeHypothesisMsgs = [
            ...activeHypothesisMsgs,
            {
              role: "system" as const,
              content: `[Active Plan Step Reminder]
Active Plan: ${currentPlanState.plan.title || planId}
Current Step: ${s.id} (kind: ${s.kind})
Goal: ${s.goal}
Target Files: ${s.targetFiles?.join(", ") || "none"}
Done When: ${s.doneWhen || "not specified"}
Fallback: ${s.fallback || "none"}
Executor Hint: ${s.executorHint ?? "main"}${s.subagentRole ? ` (${s.subagentRole})` : ""}

Focus ONLY on achieving the goal of this step. Do not deviate.
When the conditions in 'Done When' are fully met, you MUST call the tool 'plan_step_complete' to proceed.
After a step is completed, continue immediately with the next plan step in the same run. Do not ask the user whether to continue between steps.
${s.executorHint === "subagent" && s.subagentRole ? `This step is assigned to a subagent. Before any non-coordinator tool use, you MUST call 'delegate_subagent' with role='${s.subagentRole}'. Do not execute this step directly from the coordinator.` : ""}
If you hit an unrecoverable failure or block, call 'plan_step_fail' with a clear explanation.`
            }
          ]
        }
      }
    }

    const preparedTurn = prepareProviderTurnRequest({
      context: this.context,
      step,
      maxSteps: this.maxSteps,
      agent,
      instructions,
      skills,
      selectedSkills,
      pendingSkillLoads: this.pendingSelectedSkills(selectedSkills),
      tools,
      usedTools,
      activeHypothesisMessages: activeHypothesisMsgs,
      activePlanStepId: activePlanStep?.id,
    })
    const providerMessages = shouldInjectReviewPlanningTemplate(prompt, requiresProposedPlan)
      ? [...preparedTurn.providerMessages, { role: "system" as const, content: reviewPlanningTemplate(prompt) }]
      : preparedTurn.providerMessages

    let currentState = this.aspect.transition("streaming", { step: step + 1 })
    const turn = await this.runValidatedProviderTurn({
      agent,
      prompt,
      messages: this.context.state.messages,
      providerMessages,
      tools: preparedTurn.availableTools,
      signal: input.signal,
      providerMetrics,
    }, requiresProposedPlan, activePlanStep)

    const currentReasoningTranscript = appendOutput(reasoningTranscript, turn.reasoningText)
    if (turn.cancelledOutput) {
      return { action: "cancel", output: turn.cancelledOutput, reasoningTranscript: currentReasoningTranscript }
    }

    const nextReasoningTranscript = currentReasoningTranscript
    if (input.signal?.aborted) {
      return { action: "cancel", output: appendOutput(turn.text, "Run cancelled by user."), reasoningTranscript: nextReasoningTranscript }
    }

    if (turn.retryMessage) {
      this.onEvent?.({ type: "failure", text: turn.retryMessage })
      if (requiresProposedPlan && (turn.validationFailureCount ?? 0) >= 3) {
        const output = buildPlanGateFallbackMessage(turn)
        this.onEvent?.({ type: "failure", text: output })
        this.context.add(assistantMessage(nextReasoningTranscript, output))
        currentState = this.aspect.runFailed("provider_error", usedTools)
        this.emitRunDone("failed", providerMetrics)
        return {
          action: "exit",
          result: { status: "failed", failureReason: "provider_error", text: output, reasoning: nextReasoningTranscript, messages: this.context.state.messages, usedTools, state: currentState }
        }
      }
      this.context.add(textMessage("system", turn.retryMessage))
      return {
        action: "continue",
        reasoningTranscript: nextReasoningTranscript,
        latestAssistantText,
        state: this.aspect.transition("streaming", { step: step + 1 })
      }
    }

    if (turn.failureText) {
      const output = appendOutput(turn.text, turn.failureText)
      this.context.add(assistantMessage(nextReasoningTranscript, output))
      currentState = this.aspect.runFailed("provider_error", usedTools)
      this.emitRunDone("failed", providerMetrics)
      return {
        action: "exit",
        result: { status: "failed", failureReason: "provider_error", text: output, reasoning: nextReasoningTranscript, messages: this.context.state.messages, usedTools, state: currentState }
      }
    }

    let nextLatestAssistantText = latestAssistantText
    if (turn.text) nextLatestAssistantText = turn.text

    if (turn.toolCalls.length === 0) {
      const output = turn.text
      if (protocol.hasProposedPlanText(output)) this.hasProposedPlan = true
      this.context.add(assistantMessage(nextReasoningTranscript, output))
      currentState = this.aspect.transition("completed", { usedTools })
      this.emitRunDone("completed", providerMetrics)
      return {
        action: "exit",
        result: { status: "completed", text: output, reasoning: nextReasoningTranscript, messages: this.context.state.messages, usedTools, state: currentState }
      }
    }

    currentState = this.aspect.transition("tool_pending", { tools: turn.toolCalls.map((call) => call.name), callIDs: turn.toolCalls.map((call) => call.id) })
    this.context.add(toolCallMessage(turn.toolCalls, turn.reasoningText, turn.text))

    for (const toolCall of turn.toolCalls) {
      const toolCallResult = await this.executeToolCall(
        toolCall,
        effectiveMode,
        input.signal,
        usedTools,
        prompt,
        selectedSkills,
        nextReasoningTranscript,
        providerMetrics
      )

      if (toolCallResult.action === "cancel") {
        return { action: "cancel", reasoningTranscript: nextReasoningTranscript }
      }

      if (toolCallResult.action === "exit") {
        return { action: "exit", result: toolCallResult.result }
      }

      currentState = toolCallResult.state
    }

    currentState = this.aspect.transition("streaming", { nextStep: step + 2 })

    return {
      action: "continue",
      reasoningTranscript: nextReasoningTranscript,
      latestAssistantText: nextLatestAssistantText,
      state: currentState
    }
  }

  private async runProviderTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    const provider = input.provider ?? this.provider
    return runProviderTurnStream(
      {
        provider,
        providerProgressIntervalMs: this.providerProgressIntervalMs,
        onEvent: this.onEvent,
        onTextDelta: this.onTextDelta,
        onUsage: (event) => this.context.observeUsage(event),
      },
      input,
      (text) => runFailureText(text, "provider_error"),
    )
  }

  private async runValidatedProviderTurn(input: ProviderTurnInput, requiresProposedPlan: boolean, activePlanStep?: PlanStep): Promise<ProviderTurnResult> {
    return runValidatedProviderTurnLoop(
      {
        runProviderTurn: (nextInput) => this.runProviderTurn(nextInput),
        emitProviderTurn: (turn) => this.emitProviderTurn(turn),
        updateActiveHypothesis: (summary, normalized) => this.updateActiveHypothesis(summary, normalized),
        recordHypothesisViolation: (violation) => this.recordHypothesisViolation(violation),
        hypothesisCorrectionMessage,
        validateTurn: (turn) => {
          if (requiresProposedPlan) {
            if (protocol.isProposalPlanTurn(turn)) return undefined
            if (turn.toolCalls.length > 0) return undefined
            return {
              correction: [
                "Planning mode hard gate:",
                "- Your next assistant turn must return a proposal plan.",
                "- Return either a final <proposed_plan>...</proposed_plan> block or call plan_exit.",
                "- Read-only planning tools are allowed before the final plan, but do not finish with ordinary status text.",
                "- Fold already gathered evidence into the proposal plan itself.",
              ].join("\n"),
              failureText: "Planning mode hard gate failed: the model must submit a proposal plan before ending the planning run.",
            }
          }
          if (requiresReviewerDelegationBeforeFinal(input.prompt, activePlanStep) && turn.toolCalls.length === 0 && turn.text.trim() && !hasSuccessfulReviewerSubagent(this.context.state.messages)) {
            return {
              correction: [
                "Reviewer delegation anti-pattern gate:",
                "- Before outputting a review/repair/optimization plan, check whether the review can be delegated to reviewer.",
                "- This task can be split into bounded review scopes such as Code Complete dimensions, file groups, type-safety, error handling, or test coverage.",
                "- Do not complete the whole review as coordinator.",
                "- Call delegate_subagent with role='reviewer' for at least one bounded review task, then synthesize only the reviewer conclusion.",
              ].join("\n"),
              failureText: "Reviewer delegation gate failed: broad review output requires a bounded reviewer subagent result before final synthesis.",
            }
          }
          const requiredDelegationRole = activePlanStep?.executorHint === "subagent" ? activePlanStep.subagentRole : undefined
          const directCoordinatorTools = turn.toolCalls.filter((call) => !isCoordinatorOnlyTool(call.name))
          if (requiredDelegationRole && directCoordinatorTools.length > 0 && !turn.toolCalls.some((call) => call.name === "delegate_subagent")) {
            const toolNames = [...new Set(directCoordinatorTools.map((call) => call.name))].join(", ")
            return {
              correction: [
                "Plan step delegation gate:",
                `- The active plan step is assigned to subagent role='${requiredDelegationRole}'.`,
                `- Do not execute coordinator tools directly for this step (${toolNames}).`,
                `- Call delegate_subagent with role='${requiredDelegationRole}' and a narrow task first.`,
                "- Include explicit success_criteria so the coordinator can review the bounded result.",
              ].join("\n"),
              failureText: `Plan step delegation gate failed: step '${activePlanStep?.id ?? "unknown"}' must delegate to role='${requiredDelegationRole}' before direct coordinator execution.`,
            }
          }
          if (requiresProposedPlan) return undefined
          if (!shouldEnforceCoordinatorDelegation(input.provider ?? this.provider)) return undefined
          if (lastSubagentDelegationFailedOrHandoff(this.context.state.messages)) return undefined
          const suggestedRole = suggestedCoordinatorSubagentRole(turn.toolCalls, {
            taskHint: [input.prompt, activePlanStep?.goal, activePlanStep?.doneWhen].filter(Boolean).join("\n"),
          })
          if (!suggestedRole) return undefined
          const toolNames = [...new Set(turn.toolCalls.map((call) => call.name))].join(", ")
          return {
            correction: [
              "Coordinator delegation gate:",
              `- The current tool plan is pure bounded retrieval or verification (${toolNames}).`,
              `- Do not run those tools directly from the coordinator in this turn.`,
              `- Call delegate_subagent with role='${suggestedRole}' and a narrow task instead.`,
              "- Include explicit success_criteria so the coordinator receives a concrete bounded result.",
            ].join("\n"),
            failureText: `Coordinator delegation gate failed: pure bounded retrieval or verification must use delegate_subagent role='${suggestedRole}' instead of direct coordinator tools (${toolNames}).`,
          }
        },
        reportTurnValidationFailure: ({ failure, attempts, maxAttempts, shouldRetry, turn }) => {
          emitLog(this.logger, {
            type: "provider",
            name: "provider.validation_rejected",
            detail: {
              attempt: attempts,
              maxAttempts,
              shouldRetry,
              failureText: failure.failureText,
              correction: failure.correction,
              reasoningContent: turn.reasoningText,
              output: turn.text,
              toolNames: turn.toolCalls.map((call) => call.name),
            },
          })
        },
        activeHypothesis: this.activeHypothesis,
        evidenceRevision: this.evidenceRevision,
      },
      input,
    )
  }

  private emitProviderTurn(turn: ProviderTurnResult) {
    emitProviderTurnEvents(turn, { onEvent: this.onEvent, onTextDelta: this.onTextDelta })
  }

  private cancelledResult(reasoningTranscript: string, usedTools: string[], output = "Run cancelled by user.", providerMetrics?: ProviderMetricsAccumulator) {
    return createCancelledRunResult({
      aspect: this.aspect,
      context: this.context,
      onEvent: this.onEvent,
      reasoningTranscript,
      usedTools,
      output,
      providerMetrics,
    })
  }

  private async compactContext() {
    if (this.summarySubagent || !this.context.needsCompaction()) return
    const snapshot = this.context.compactionSnapshot()
    if (!snapshot) return
    this.startSummarySubagent(snapshot)
  }

  async waitForSummarySubagent() {
    await this.summarySubagent?.promise
  }

  private startSummarySubagent(snapshot: ContextCompactionSnapshot) {
    const route = resolveSubagentRoute({
      role: "summary",
      provider: this.provider.name,
      model: this.provider.model,
      capabilities: this.provider.capabilities,
      settings: this.settings,
      maxOutputTokens: this.context.strategyState.dynamicSummaryTokenBudget,
    })
    const requestId = this.nextSummarySubagentID++
    const provider = createDerivedSubagentProvider(this.provider, route, (nextProvider) => withSubagentLogContext(nextProvider, this.subagentLogger, { requestId, role: route.role, task: "Context compaction summary" }))
    const task = createSummaryTask(requestId, createAgent("summary"), route, provider, snapshot)
    this.summarySubagent = task
    emitLog(this.subagentLogger, {
      type: "state",
      name: "subagent.route",
      detail: {
        requestId: task.id,
        role: route.role,
        provider: route.provider,
        model: route.model,
        thinking: route.thinking,
        effort: route.effort,
        maxProviderCalls: route.maxProviderCalls,
        maxOutputTokens: route.maxOutputTokens,
      },
    })
    emitLog(this.subagentLogger, {
      type: "provider",
      name: "provider.subagent_route",
      detail: {
        id: task.id,
        role: route.role,
        provider: route.provider,
        model: route.model,
        thinking: route.thinking,
        effort: route.effort,
        maxProviderCalls: route.maxProviderCalls,
        maxOutputTokens: route.maxOutputTokens,
      },
    })
    this.onEvent?.({
      type: "subagent",
      status: "scheduled",
      info: {
        id: task.id,
        role: route.role,
        provider: route.provider,
        model: route.model,
        thinking: route.thinking,
        effort: route.effort,
        maxProviderCalls: route.maxProviderCalls,
        maxOutputTokens: route.maxOutputTokens,
      },
    })
    this.onEvent?.({ type: "context_compaction", status: "started", inputMessages: snapshot.providerMessages.length })
    task.promise = this.runSummarySubagent(task)
    void task.promise
  }

  private async runSummarySubagent(task: BackgroundAgentTask) {
    const providerMetrics = createProviderMetrics(task.provider.name, task.provider.model, {
      source: "subagent",
      subagentRole: task.route.role,
      thinking: task.route.thinking,
      effort: task.route.effort,
      maxOutputTokens: task.route.maxOutputTokens,
      maxProviderCalls: task.route.maxProviderCalls,
    })
    try {
      await runSummarySubagentTask({
        context: this.context,
        onEvent: this.onEvent,
        onBackgroundContextUpdate: this.onBackgroundContextUpdate,
        activeHypothesisSummary: this.activeHypothesis?.summary,
        compactPrompt,
        summaryLanguageHint,
        ledgerValue,
        runProviderTurn: (input) => this.runProviderTurn({
          ...input,
          provider: input.provider,
          messages: [],
          tools: [],
        }),
      }, task, providerMetrics)
    } finally {
      this.finishForegroundSubagent(task.id)
      if (this.summarySubagent?.id === task.id) this.summarySubagent = undefined
    }
  }

  private async executeDelegateSubagentToolCall(toolCall: ToolCall, signal: AbortSignal | undefined): Promise<ToolResult> {
    const request = parseSubagentRequest(toolCall.input)
    if (!request) {
      return {
        title: "delegate_subagent",
        output: formatSubagentResult({ role: "summary", status: "failed", summary: "Invalid delegate_subagent input. Expected role, task, and optional success_criteria." }),
        metadata: { status: "failed", error: "invalid_subagent_request" },
      }
    }
    const route = resolveSubagentRoute({
      role: request.role,
      provider: this.provider.name,
      model: this.provider.model,
      capabilities: this.provider.capabilities,
      settings: this.settings,
    })
    const reservation = this.reserveSubagentBudget(request.role, route.maxProviderCalls)
    if (!reservation.ok) {
      const detail = reservation.reason
      this.onEvent?.({
        type: "subagent",
        status: "failed",
        info: {
          id: this.nextSubagentRequestID,
          role: route.role,
          provider: route.provider,
          model: route.model,
          thinking: route.thinking,
          effort: route.effort,
          maxProviderCalls: route.maxProviderCalls,
          maxOutputTokens: route.maxOutputTokens,
        },
        error: detail,
      })
      emitLog(this.subagentLogger, { type: "state", name: "subagent.budget_denied", detail: { requestId: this.nextSubagentRequestID, role: request.role, reason: detail, budget: reservation.snapshot } })
      return budgetDeniedToolResult(request.role, reservation.error, detail)
    }

    const requestId = this.nextSubagentRequestID++
    this.activeForegroundSubagentRequestID = requestId
    const maxProviderCalls = reservation.reservedTurns
    const provider = createDerivedSubagentProvider(
      this.provider,
      route,
      (nextProvider) => withSubagentLogContext(nextProvider, this.subagentLogger, { requestId, role: request.role, task: request.task }),
    )
    const info = {
      id: requestId,
      role: route.role,
      provider: route.provider,
      model: route.model,
      thinking: route.thinking,
      effort: route.effort,
      maxProviderCalls,
      maxOutputTokens: route.maxOutputTokens,
    } as const
    this.onEvent?.({ type: "subagent", status: "scheduled", info })
    emitLog(this.subagentLogger, { type: "state", name: "subagent.request", detail: { requestId, role: request.role, task: request.task, successCriteria: request.successCriteria, route, budget: reservation.snapshot } })
    emitLog(this.subagentLogger, { type: "state", name: "subagent.start", detail: { requestId, role: request.role } })
    emitLog(this.subagentLogger, {
      type: "provider",
      name: "provider.subagent_route",
      detail: {
        id: requestId,
        role: route.role,
        provider: route.provider,
        model: route.model,
        thinking: route.thinking,
        effort: route.effort,
        maxProviderCalls,
        maxOutputTokens: route.maxOutputTokens,
      },
    })

    const providerMetrics = createProviderMetrics(provider.name, provider.model, {
      source: "subagent",
        subagentRole: request.role,
        thinking: route.thinking,
        effort: route.effort,
        maxOutputTokens: route.maxOutputTokens,
        maxProviderCalls,
      })
    let taskState: SubagentTaskState | undefined
    try {
      taskState = createSubagentTaskState({
        requestId,
        role: request.role,
        task: request.task,
        successCriteria: request.successCriteria,
        maxProviderCalls,
        assignedStep: await this.currentAssignedSubagentStep(),
      })
      const result = await this.runGenericSubagent(requestId, taskState, provider, providerMetrics, signal)
      this.finishReservedSubagentTurns(reservation.reservedTurns, providerMetrics.calls)
      const metrics = providerMetrics.calls > 0 ? finalizeProviderMetrics(providerMetrics) : undefined
      this.recordSubagentInvocationSummary({
        requestId,
        role: request.role,
        status: result.status,
        turnsUsed: taskState.turnsUsed,
        providerCalls: providerMetrics.calls,
        metrics,
        budgetSnapshot: this.subagentBudgetSnapshot(request.role),
      })
      this.onEvent?.({ type: "subagent", status: result.status === "failed" ? "failed" : "completed", info, elapsedMs: metrics?.providerElapsedMs, error: result.status === "failed" ? result.summary : undefined, metrics })
      emitLog(this.subagentLogger, {
        type: "state",
        name: "subagent.result",
        detail: {
          requestId,
          role: request.role,
          status: result.status,
          turnsUsed: providerMetrics.calls,
          provider: route.provider,
          model: route.model,
          thinking: route.thinking,
          effort: route.effort,
          budget: this.subagentBudgetSnapshot(request.role),
          summary: result.summary,
        },
      })
      return {
        title: `subagent ${request.role}`,
        output: formatSubagentResult(result),
        metadata: { status: result.status === "failed" ? "failed" : "succeeded", subagentStatus: result.status, subagentRole: request.role, subagentRequestId: requestId, provider: route.provider, model: route.model, thinking: route.thinking, effort: route.effort, turnsUsed: providerMetrics.calls, nextAction: result.nextAction },
      }
    } catch (error) {
      this.finishReservedSubagentTurns(reservation.reservedTurns, providerMetrics.calls)
      const detail = error instanceof Error ? error.message : String(error)
      const metrics = providerMetrics.calls > 0 ? finalizeProviderMetrics(providerMetrics) : undefined
      this.recordSubagentInvocationSummary({
        requestId,
        role: request.role,
        status: "failed",
        turnsUsed: taskState?.turnsUsed ?? providerMetrics.calls,
        providerCalls: providerMetrics.calls,
        metrics,
        budgetSnapshot: this.subagentBudgetSnapshot(request.role),
      })
      emitLog(this.subagentLogger, { type: "state", name: "subagent.result", detail: { requestId, role: request.role, status: "failed", error: detail, turnsUsed: providerMetrics.calls, budget: this.subagentBudgetSnapshot(request.role) } })
      this.onEvent?.({ type: "subagent", status: "failed", info, error: detail, elapsedMs: providerMetrics.providerElapsedMs, metrics })
      return {
        title: `subagent ${request.role}`,
        output: formatSubagentResult({ role: request.role, status: "failed", summary: detail }),
        metadata: { status: "failed", error: "subagent_execution_failed", subagentRole: request.role, subagentRequestId: requestId },
      }
    } finally {
      this.activeForegroundSubagentRequestID = undefined
    }
  }

  private async runGenericSubagent(
    requestId: number,
    taskState: SubagentTaskState,
    provider: Provider,
    providerMetrics: ProviderMetricsAccumulator,
    signal: AbortSignal | undefined,
  ): Promise<SubagentExecutionResult> {
    const { packet } = taskState
    const agent = createAgent(packet.role)
    const context = new ContextManager({ maxTokens: this.settings.maxTokens, contextWindowTokens: this.provider.capabilities?.contextWindowTokens ?? this.settings.maxTokens })
    context.add(userMessage(buildSubagentTaskPrompt(packet, this.context.selectedLedgerText(), this.context.state.summary, this.recentSubagentResults()), []))
    const tools = filterToolsForAgent(this.subagentRegistry.list("build"), { role: packet.role, depth: agent.depth ?? 1 })
    const reasoningChunks: string[] = []

    for (let callIndex = 0; callIndex < packet.maxProviderCalls; callIndex += 1) {
      const providerMessages = context.compose({ agent, instructions: [], skills: [], selectedSkills: [], pendingSkillLoads: [], tools })
      const turn = await runProviderTurnStream(
        {
          provider,
          providerProgressIntervalMs: 0,
          onUsage: (event) => context.observeUsage(event),
        },
        {
          agent,
          prompt: packet.task,
          messages: context.state.messages,
          providerMessages,
          tools,
          signal,
          providerMetrics,
          emitDeltas: false,
          emitProgressEvents: false,
          observeContextUsage: true,
        },
        (text) => runFailureText(text, "provider_error"),
      )

      if (turn.failureText) {
        return { role: packet.role, status: "failed", summary: turn.failureText }
      }
      if (turn.cancelledOutput) {
        return { role: packet.role, status: "failed", summary: "Subagent cancelled." }
      }
      if (turn.reasoningText) reasoningChunks.push(turn.reasoningText)
      noteSubagentTurn(taskState, turn.text)
      emitLog(this.subagentLogger, {
        type: "state",
        name: "subagent.task_progress",
        detail: {
          requestId,
          role: packet.role,
          turnsUsed: taskState.turnsUsed,
          turnsRemaining: Math.max(0, packet.maxProviderCalls - taskState.turnsUsed),
          lastAssistantText: taskState.lastAssistantText,
        },
      })
      if (turn.toolCalls.length === 0) {
        const summary = turn.text.trim() || "Subagent completed without a final text summary."
        context.add(assistantMessage(reasoningChunks.join("\n"), summary))
        return {
          role: packet.role,
          status: "succeeded",
          summary,
          ...(taskState.findings.length > 0 ? { findings: taskState.findings.slice(0, 6) } : {}),
          ...(taskState.evidenceRefs.length > 0 ? { evidenceRefs: taskState.evidenceRefs.slice(0, 6) } : {}),
          ...(taskState.artifacts.length > 0 ? { artifacts: taskState.artifacts.slice(0, 6) } : {}),
        }
      }

      context.add(toolCallMessage(turn.toolCalls, turn.reasoningText, turn.text))
      for (const call of turn.toolCalls) {
        const result = await this.executeSubagentInnerToolCall(requestId, taskState, context, call, signal)
        noteSubagentToolResult(taskState, {
          toolName: call.name,
          title: result.title,
          status: String(result.metadata.status ?? "failed"),
          output: result.output,
        })
        context.add(toolResultMessage({
          callID: call.id,
          toolName: call.name,
          status: result.metadata.status === "succeeded" ? "succeeded" : result.metadata.status === "denied" ? "denied" : "failed",
          output: result.output,
          metadata: result.metadata,
        }))
      }
    }

    return buildSubagentHandoffResult(taskState)
  }

  private async executeSubagentInnerToolCall(
    requestId: number,
    taskState: SubagentTaskState,
    context: ContextManagerLike,
    call: ToolCall,
    signal: AbortSignal | undefined,
  ) {
    if (call.name === "delegate_subagent") {
      const detail = "Current subagent cannot create or delegate another subagent. Use the available tools and return your result directly."
      noteSubagentBlockedAction(taskState, call.name)
      emitLog(this.subagentLogger, { type: "state", name: "subagent.nesting_blocked", detail: { requestId, role: taskState.packet.role, tool: call.name } })
      return blockedInternalActionToolResult(call.name, "subagent_nesting_blocked", detail)
    }
    if (isCoordinatorOnlyTool(call.name)) {
      const detail = "Current subagent cannot use coordinator-only internal actions. Return your result directly instead."
      noteSubagentBlockedAction(taskState, call.name)
      emitLog(this.subagentLogger, { type: "state", name: "subagent.internal_action_blocked", detail: { requestId, role: taskState.packet.role, tool: call.name } })
      return blockedInternalActionToolResult(call.name, "subagent_internal_action_blocked", detail)
    }
    return runToolCall({
      registry: this.subagentRegistry,
      sandbox: this.subagentSandbox,
      permission: new PermissionService(defaultSubagentPermissionRules(taskState.packet.role), () => "reject"),
      permissionFor: () => new PermissionService(defaultSubagentPermissionRules(taskState.packet.role), () => "reject"),
      skills: this.subagentSkills,
      context,
      toolProgressIntervalMs: 0,
    }, call, "build", signal)
  }

  private emitRunDone(status: string, providerMetrics: ProviderMetricsAccumulator | undefined) {
    emitRunDoneEvent(this.onEvent, status, providerMetrics)
  }

  private async selectedSkills() {
    return selectedSkillsForSettings(this.skills, this.settings)
  }

  private pendingSelectedSkills(selectedSkills: Awaited<ReturnType<AgentRunner["selectedSkills"]>>) {
    return pendingSelectedSkillsForSettings(this.settings, selectedSkills)
  }

  private recentSubagentResults(limit = 4) {
    const results: string[] = []
    for (const message of [...this.context.state.messages].reverse()) {
      for (const part of [...message.parts].reverse()) {
        if (part.type !== "tool_result") continue
        if (part.toolName !== "delegate_subagent" || part.status !== "succeeded") continue
        if (part.output.trim()) results.push(part.output.trim())
        if (results.length >= limit) return results.reverse()
      }
    }
    return results.reverse()
  }

  private markSkillLoaded(input: unknown) {
    markSkillLoadedInSettings(this.settings, input)
  }

  private effectiveMode(prompt: string, mode: AgentMode): AgentMode {
    return effectiveModeForPrompt(prompt, mode, this.hasProposedPlan)
  }

  private permissionFor(mode: AgentMode) {
    return permissionServiceForMode(this.permission, mode)
  }

  private recordRunIntent(prompt: string) {
    recordRunIntentState(this.context, prompt)
    if (this.sessionId) {
      this.context.updateLedger({
        current: [
          ledgerRecord("checkpoint", "current_session_id", this.sessionId, "current", this.context.state.messages.length)
        ]
      })
    }
  }

  private async maybeRecallProjectMemory(prompt: string) {
    if (!shouldAutoRecallProjectMemory(prompt)) return
    const activeFiles = this.context.state.ledger?.current
      .flatMap((record) => record.scope?.files ?? [])
      .filter(Boolean) ?? []
    const records = await new ProjectMemoryStore(this.root).query(prompt, maxAutoRecalledMemoryRecords, {
      kinds: [...autoRecallMemoryKinds],
      activeFiles,
    })
    if (records.length === 0) return
    const rendered = renderProjectMemoryRecall(records, compactLine(prompt))
    if (this.context.state.messages.some((message) => message.role === "system" && message.parts.some((part) => part.type === "text" && part.text === rendered))) return
    this.context.add(textMessage("system", rendered))
    const turn = this.context.state.messages.length
    this.context.updateLedger({
      current: records.map((record) =>
        ledgerRecord("checkpoint", "project_memory_recall", truncateForLedger(memoryLedgerValue(record), 240), "current", turn, {
          evidence: { source: "assistant" },
          scope: memoryScopeToLedger(record),
        })
      ),
    })
  }

  private recordActiveSkills(selectedSkills: Awaited<ReturnType<AgentRunner["selectedSkills"]>>) {
    recordActiveSkillState(this.context, selectedSkills, this.settings.pendingSkillLoads ?? [])
  }

  private async refreshRepoMap(signal: AbortSignal | undefined, prompt?: string) {
    await refreshRepoMapCache({
      sandbox: this.sandbox,
      context: this.context,
      onEvent: this.onEvent,
      truncateForLedger,
    }, signal, prompt)
  }

  private recordToolOutcome(call: ToolCall, result: { title: string; output: string; metadata: Record<string, unknown> }, prompt: string) {
    recordToolOutcomeSideEffect({ context: this.context }, call, result, prompt, { truncateForLedger, compactLine })
  }

  private async autoInspectSkillArtifacts(
    result: { metadata: Record<string, unknown> },
    mode: AgentMode,
    signal: AbortSignal | undefined,
    prompt: string,
    usedTools: string[],
  ) {
    const calls = autoSkillArtifactCalls(result.metadata.artifacts, this.root)
    if (calls.length === 0) return
    this.context.add(toolCallMessage(calls))
    for (const call of calls) {
      usedTools.push(call.name)
      const inspection = await runToolCall({
        registry: this.registry,
        sandbox: this.sandbox,
        permission: this.permission,
        permissionFor: (nextMode) => this.permissionFor(nextMode),
        skills: this.skills,
        context: this.context,
        onEvent: this.onEvent,
        toolProgressIntervalMs: this.toolProgressIntervalMs,
      }, call, mode, signal)
      this.recordToolOutcome(call, inspection, prompt)
      this.context.add(toolResultMessage({
        callID: call.id,
        toolName: call.name,
        status: inspection.metadata.status === "succeeded" ? "succeeded" : inspection.metadata.status === "denied" ? "denied" : "failed",
        output: inspection.output,
        metadata: inspection.metadata,
      }))
      this.noteExternalEvidence()
      emitToolResultEvent({ onEvent: this.onEvent }, call, inspection)
      if (signal?.aborted || inspection.metadata.cancelled === true) return
    }
  }

  private reserveSubagentBudget(role: SubagentRequest["role"], requestedTurns: number) {
    const snapshot = this.subagentBudgetSnapshot(role)
    if (this.subagentUsage.startedInvocations >= maxSubagentInvocationsPerRun) {
      return { ok: false as const, error: "subagent_budget_denied" as const, reason: `Subagent budget denied: invocation cap ${maxSubagentInvocationsPerRun} reached.`, snapshot }
    }
    if (this.subagentUsage.byRole[role] >= roleInvocationLimit(role)) {
      return { ok: false as const, error: "subagent_role_disabled" as const, reason: `Subagent budget denied: role ${role} already used ${this.subagentUsage.byRole[role]}/${roleInvocationLimit(role)} times this run.`, snapshot }
    }
    if (role !== "summary" && this.activeForegroundSubagentRequestID !== undefined) {
      return { ok: false as const, error: "subagent_concurrency_blocked" as const, reason: `Subagent concurrency blocked: request ${this.activeForegroundSubagentRequestID} is still running.`, snapshot }
    }
    const remainingTurns = maxSubagentTurnsPerRun - this.subagentUsage.usedTurns - this.subagentUsage.reservedTurns
    if (remainingTurns <= 0) {
      return { ok: false as const, error: "subagent_budget_denied" as const, reason: `Subagent budget denied: turn cap ${maxSubagentTurnsPerRun} would be exceeded.`, snapshot }
    }
    const reservedTurns = Math.max(1, Math.min(requestedTurns, remainingTurns))
    this.subagentUsage.startedInvocations += 1
    this.subagentUsage.byRole[role] += 1
    this.subagentUsage.statsByRole[role].started += 1
    this.subagentUsage.reservedTurns += reservedTurns
    return {
      ok: true as const,
      reservedTurns,
      snapshot: this.subagentBudgetSnapshot(role),
    }
  }

  private finishReservedSubagentTurns(reservedTurns: number, actualTurns: number) {
    this.subagentUsage.reservedTurns = Math.max(0, this.subagentUsage.reservedTurns - reservedTurns)
    this.subagentUsage.usedTurns += actualTurns
  }

  private finishForegroundSubagent(requestId: number) {
    if (this.activeForegroundSubagentRequestID === requestId) this.activeForegroundSubagentRequestID = undefined
  }

  private subagentBudgetSnapshot(role: SubagentRequest["role"]): SubagentBudgetSnapshot {
    return {
      totalInvocationLimit: maxSubagentInvocationsPerRun,
      totalTurnLimit: maxSubagentTurnsPerRun,
      usedInvocations: this.subagentUsage.startedInvocations,
      usedTurns: this.subagentUsage.usedTurns,
      reservedTurns: this.subagentUsage.reservedTurns,
      roleInvocationLimit: roleInvocationLimit(role),
      roleInvocations: this.subagentUsage.byRole[role],
    }
  }

  private recordSubagentInvocationSummary(input: {
    requestId: number
    role: SubagentRole
    status: SubagentExecutionResult["status"]
    turnsUsed: number
    providerCalls: number
    metrics?: ReturnType<typeof finalizeProviderMetrics>
    budgetSnapshot: SubagentBudgetSnapshot
  }) {
    const stats = this.subagentUsage.statsByRole[input.role]
    if (input.status === "succeeded") stats.succeeded += 1
    if (input.status === "failed") stats.failed += 1
    if (input.status === "handoff") stats.handoff += 1
    stats.turnsUsed += input.turnsUsed
    stats.inputTokens += input.metrics?.inputTokens ?? 0
    stats.outputTokens += input.metrics?.outputTokens ?? 0
    stats.cacheHitTokens += input.metrics?.cacheHitTokens ?? 0
    stats.cacheMissTokens += input.metrics?.cacheMissTokens ?? 0
    const detail = {
      role: input.role,
      requestId: input.requestId,
      status: input.status,
      turnsUsed: input.turnsUsed,
      providerCalls: input.providerCalls,
      tokens: {
        inputTokens: input.metrics?.inputTokens ?? 0,
        outputTokens: input.metrics?.outputTokens ?? 0,
      },
      cache: {
        cacheHitTokens: input.metrics?.cacheHitTokens ?? 0,
        cacheMissTokens: input.metrics?.cacheMissTokens ?? 0,
        hitRate: input.metrics?.hitRate ?? 0,
      },
      budgetSnapshot: input.budgetSnapshot,
    }
    emitLog(this.logger, { type: "state", name: "subagent.invocation_summary", detail })
    emitLog(this.subagentLogger, { type: "state", name: "subagent.invocation_summary", detail })
  }

  private emitSubagentUsageSummary() {
    if (this.subagentUsage.startedInvocations === 0) return
    const byRole = Object.fromEntries(
      subagentRoles
        .map((role) => [role, this.subagentUsage.statsByRole[role]] as const)
        .filter(([, stats]) => stats.started > 0),
    )
    const detail = {
      total: {
        started: this.subagentUsage.startedInvocations,
        turnsUsed: this.subagentUsage.usedTurns,
        reservedTurns: this.subagentUsage.reservedTurns,
      },
      byRole,
    }
    emitLog(this.logger, { type: "state", name: "subagent.usage_summary", detail })
    emitLog(this.subagentLogger, { type: "state", name: "subagent.usage_summary", detail })
  }

  private noteExternalEvidence() {
    this.evidenceRevision += 1
  }

  private activeHypothesisMessages() {
    return activeHypothesisMessages(this.activeHypothesis)
  }

  private updateActiveHypothesis(summary: string, normalized: string) {
    this.activeHypothesis = updateActiveHypothesisState(this.context, this.activeHypothesis, summary, normalized, this.evidenceRevision)
  }

  private recordHypothesisViolation(violation: HypothesisViolation) {
    recordHypothesisViolationState(this.context, this.activeHypothesis, violation)
  }

  private async currentAssignedSubagentStep(): Promise<SubagentAssignedStep | undefined> {
    const activePlanIdRec = this.context.state.ledger?.current.find((record) => record.subject === "current_plan_id" && record.status === "current")
    if (!activePlanIdRec) return undefined
    const sessionId = this.sessionId || "default"
    const currentPlanState = await loadStructuredPlanState(this.root, sessionId, activePlanIdRec.value)
    const stepId = currentPlanState?.checkpoint.currentStepId
    if (!currentPlanState || !stepId) return undefined
    const step = currentPlanState.plan.steps.find((candidate) => candidate.id === stepId)
    if (!step) return undefined
    return {
      planId: currentPlanState.plan.id,
      stepId: step.id,
      goal: step.goal,
      ...(step.doneWhen ? { doneWhen: step.doneWhen } : {}),
    }
  }
}

export function createRunner(input: { root: string; provider?: ProviderName; mode?: AgentMode; logger?: Logger; context?: ContextManagerLike; permission?: PermissionService; onTextDelta?: (text: string) => void; onEvent?: (event: RunUiEvent) => void; onBackgroundContextUpdate?: () => void | Promise<void>; toolProgressIntervalMs?: number; settings?: SessionSettings; sessionId?: string; forcePlanning?: boolean }) {
  const settings = input.settings ?? defaultSessionSettings(input.provider ?? "fake")
  return new AgentRunner({ root: input.root, provider: createProvider(input.provider ?? settings.provider ?? "fake", { model: settings.model, thinking: settings.thinking, effort: settings.effort }), permission: input.permission ?? PermissionService.autoApprove(defaultPermissionRules(input.mode ?? "build")), logger: input.logger, context: input.context, onTextDelta: input.onTextDelta, onEvent: input.onEvent, onBackgroundContextUpdate: input.onBackgroundContextUpdate, toolProgressIntervalMs: input.toolProgressIntervalMs, settings, sessionId: input.sessionId, forcePlanning: input.forcePlanning })
}

function lastSubagentDelegationFailedOrHandoff(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    for (const part of msg.parts) {
      if (part.type === "tool_result" && part.toolName === "delegate_subagent") {
        const subagentStatus = part.metadata?.subagentStatus
        const isTruncated = typeof part.output === "string" && part.output.includes("[truncated")
        return subagentStatus === "failed" || subagentStatus === "handoff" || isTruncated
      }
    }
  }
  return false
}

function hasSuccessfulReviewerSubagent(messages: Message[]): boolean {
  return messages.some((message) => message.parts.some((part) =>
    part.type === "tool_result" &&
    part.toolName === "delegate_subagent" &&
    part.status === "succeeded" &&
    part.metadata?.subagentRole === "reviewer" &&
    part.metadata?.subagentStatus !== "failed"
  ))
}

function requiresReviewerDelegationBeforeFinal(prompt: string, activePlanStep?: PlanStep) {
  const text = [prompt, activePlanStep?.goal ?? "", activePlanStep?.doneWhen ?? ""].join("\n").toLowerCase()
  const reviewIntent = /\b(code complete|code review|review\/repair|review\/fix|audit)\b|code-complete|项目\s*review|代码审查|代码评审|审查\/修复|修复\/优化方案|优化方案/.test(text)
  const boundedReviewSignal = /\b(cc|code complete|type safety|error handling|test coverage|bounded scope|dimension|file group)\b|维度|文件组|类型安全|错误处理|测试覆盖|防御式编程/.test(text)
  const pureQuestion = /为什么|why|怎么|how/.test(text) && !/制定|输出|生成|create|write/.test(text)
  return reviewIntent && boundedReviewSignal && !pureQuestion
}

function shouldInjectReviewPlanningTemplate(prompt: string, requiresProposedPlan: boolean) {
  if (!requiresProposedPlan) return false
  return /\b(review|code review|audit|regression)\b|代码评审|代码审查|审查代码|评审代码|review 当前代码/i.test(prompt)
}

function reviewPlanningTemplate(prompt: string) {
  return [
    "Review Planning Gate Template:",
    `- The current request looks like a review task: ${compactLine(prompt) || "review task"}.`,
    "- Use only bounded read-only inspection before submitting the proposal plan.",
    "- Call plan_exit with a low-risk review plan once the review scope is clear.",
    "- Anti-pattern warning: before outputting a review/repair/optimization plan, check whether reviewer can be delegated. If a broad review can be split into bounded scopes such as Code Complete dimensions, file groups, type safety, error handling, or test coverage, include reviewer delegation; coordinator must synthesize, not do all review work itself.",
    "- Use this structure:",
    "  1. Research Phase: inspect diff/relevant files.",
    "  2. Delegation Phase: delegate bounded review or exploration work.",
    "  3. Review Phase: synthesize findings and produce the final review output.",
    "- If you need delegate_subagent or deeper multi-step investigation, put that inside plan steps instead of calling it now.",
    "- If the scope is broad, still submit a small bounded first-pass review plan now.",
  ].join("\n")
}

function buildPlanGateFallbackMessage(turn: ProviderTurnResult) {
  const rawText = turn.lastRejectedTurn?.text?.trim()
  const toolNames = turn.lastRejectedTurn?.toolNames ?? []
  const reasoning = turn.lastRejectedTurn?.reasoningText?.trim()
  const evidence = rawText
    || (toolNames.length > 0 ? `Last invalid tool intent: ${toolNames.join(", ")}.` : "")
    || (reasoning ? `Last hidden reasoning summary: ${compactLine(reasoning)}` : "")
    || "The model did not return any usable proposal content."
  return [
    "模型连续未按要求产出计划，已中断本轮执行。",
    "要求：必须先提交 proposal plan（`plan_exit` 或 `<proposed_plan>`），然后才能继续。",
    `最后一次无效输出：${evidence}`,
  ].join("\n")
}
