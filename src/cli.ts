#!/usr/bin/env bun
import path from "node:path"
import { stdout as output } from "node:process"
import { createRunner, hasProposedPlanText } from "./agent"
import type { ContextManagerLike } from "./context"
import { createLogger, emitLog } from "./logger"
import { detectUiLanguage, uiText } from "./i18n"
import type { AgentMode, ImagePart, Message } from "./message"
import { savePlan, loadStructuredPlanState } from "./plans"
import { PlanTracker } from "./agent/planner"
import { activateGoalPlan, buildGoalAssessmentPrompt, buildGoalDefinitionPrompt, buildGoalPlanningPrompt, clearGoalState, createGoalState, goalAcceptanceText, goalHasAcceptance, goalStateFromContext, goalStatusText, writeGoalState, type GoalState } from "./goal"
import { defaultPermissionAutoReviewer, defaultPermissionRules, PermissionService } from "./permission"
import { hasProvider, listProviders } from "./provider"
import { normalizeSessionTokenUsage, SessionStore, type SessionTokenUsage } from "./session"
import { normalizeSessionSettings } from "./settings"
import { parseSlashCommand } from "./slash"
import { SkillService } from "./skill"
import { LineReader, eofPrompt } from "./cli/line-reader"
import { collectRunInput, handleSlashCommand, maybeShowWebSearchSetupHint, permissionService, question, selectSession, writeCliText } from "./cli/session-helpers"
import { configuredUiLanguage, interactiveStartupEnabled, loadEnvFile, setupInteractiveEnv, setupInteractiveLanguage, setupInteractiveWebSearchEnv } from "./cli/startup"
import { TimelineRenderer, type RunUiEvent } from "./ui/timeline"
import type { ProviderRunMetrics } from "./ui/timeline"
import { TuiRenderer } from "./ui/tui"

export {
  configuredStartupModel,
  easycodeGlobalEnvHint,
  fetchStartupModelChoices,
  loadEnvFile,
  mergeEnvText,
  missingProviderEnv,
  needsEnvSetup,
  parseEnvFile,
  recentStartupModels,
  requiredEnvForProvider,
  selectStartupModel,
  startupModelChoices,
  startupModelConfig,
  startupProviders,
  configuredUiLanguage,
} from "./cli/startup"

function parseArgs(argv: string[]) {
  const normalizedArgv = normalizeLegacyModeArgv(argv)
  const mode: AgentMode = "build"

  const providerIndex = normalizedArgv.indexOf("--provider")
  const rootIndex = normalizedArgv.indexOf("--root")
  const sessionIndex = normalizedArgv.indexOf("--session")
  const modelIndex = normalizedArgv.indexOf("--model")
  const maxTokensIndex = normalizedArgv.indexOf("--max-tokens")
  const maxStepsIndex = normalizedArgv.indexOf("--max-steps")
  const logger = normalizedArgv.includes("--logger")
  if (logger) {
    process.env.EASYCODE_LOGGER = "true"
  }
  const insecure = normalizedArgv.includes("--insecure") || normalizedArgv.includes("-k")
  if (insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
  }
  const tui = !normalizedArgv.includes("--no-tui")
  const providerExplicit = providerIndex !== -1
  const rawProvider = providerIndex === -1 ? "fake" : normalizedArgv[providerIndex + 1]
  if (!hasProvider(rawProvider)) throw new Error(`Unknown provider: ${rawProvider}. Available providers: ${listProviders().join(", ")}`)
  const provider = rawProvider
  const root = rootIndex === -1 ? process.cwd() : path.resolve(normalizedArgv[rootIndex + 1])
  const explicitSession = sessionIndex === -1 ? undefined : normalizedArgv[sessionIndex + 1]
  if (sessionIndex !== -1 && (!explicitSession || explicitSession.startsWith("--"))) throw new Error("--session requires an id")
  const model = modelIndex === -1 ? undefined : normalizedArgv[modelIndex + 1]
  if (modelIndex !== -1 && (!model || model.startsWith("--"))) throw new Error("--model requires an id")
  const maxTokens = numericFlag(normalizedArgv, maxTokensIndex, "--max-tokens")
  const maxSteps = numericFlag(normalizedArgv, maxStepsIndex, "--max-steps")
  const prompt = normalizedArgv.filter((arg, index) => {
    if (arg.startsWith("--") || arg === "-k") return false
    if (providerIndex !== -1 && index === providerIndex + 1) return false
    if (rootIndex !== -1 && index === rootIndex + 1) return false
    if (sessionIndex !== -1 && index === sessionIndex + 1) return false
    if (modelIndex !== -1 && index === modelIndex + 1) return false
    if (maxTokensIndex !== -1 && index === maxTokensIndex + 1) return false
    if (maxStepsIndex !== -1 && index === maxStepsIndex + 1) return false
    return true
  }).join(" ")
  return { mode, prompt, provider, providerExplicit, model, maxTokens, maxSteps, root, logger, session: explicitSession, once: prompt.length > 0, tui, insecure }
}

function normalizeLegacyModeArgv(argv: string[]) {
  const first = argv[0]
  if (first === "build" || first === "plan") return argv.slice(1)
  return argv
}

function usage() {
  return `Usage: easycode [prompt] [--provider ${listProviders().join("|")}] [--model id] [--max-tokens n] [--max-steps n] [--root path] [--logger] [--no-tui] [--session id] [--insecure|-k]`
}

function numericFlag(argv: string[], index: number, name: string) {
  if (index === -1) return undefined
  const raw = argv[index + 1]
  const value = Number(raw)
  if (!raw || raw.startsWith("--") || !Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`)
  return Math.round(value)
}

async function main() {
  let args = parseArgs(process.argv.slice(2))
  const loadedEnvVars = await loadEnvFile(args.root)

  if (!args.providerExplicit && process.env.EASYCODE_PROVIDER && hasProvider(process.env.EASYCODE_PROVIDER)) {
    args = { ...args, provider: process.env.EASYCODE_PROVIDER }
  }
  if (interactiveStartupEnabled()) {
    await setupInteractiveLanguage(process.env)
    const preselectedProvider = args.providerExplicit && hasProvider(args.provider) ? args.provider : args.provider === "fake" ? undefined : args.provider
    const selectedProvider = await setupInteractiveEnv(args.root, process.env, preselectedProvider)
    if (!args.providerExplicit && selectedProvider && hasProvider(selectedProvider)) {
      args = { ...args, provider: selectedProvider }
    }
    await setupInteractiveWebSearchEnv(args.root, process.env)
  }

  const result = args.once ? await runOnce(args, loadedEnvVars) : await runSession(args, loadedEnvVars)
  return result.exitCode
}

function formatCliError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  if (!trimmed) return "easycode failed. Please try again."
  if (trimmed.startsWith("Usage:")) return trimmed
  return `easycode failed: ${trimmed}`
}

type CliRunResult = {
  status: "completed" | "failed" | "cancelled"
  exitCode: number
}

async function runOnce(args: ReturnType<typeof parseArgs>, loadedEnvVars = 0) {
  if (!args.prompt) throw new Error("Prompt is required")
  const logger = args.logger ? createLogger({ root: args.root, session: args.session ?? "once" }) : undefined
  emitLog(logger, { type: "data", name: "cli.args -> runner", detail: { mode: args.mode, provider: args.provider, root: args.root, session: args.session, promptMode: "single-run" } })
  emitLog(logger, { type: "data", name: ".env -> process.env", detail: { loadedEnvVars } })
  const reader = new LineReader()
  const settings = normalizeSessionSettings({ provider: args.provider, model: args.model, maxTokens: args.maxTokens, maxSteps: args.maxSteps }, args.provider)
  const tui = args.tui ? new TuiRenderer(output, { root: args.root, mode: args.mode, provider: settings.provider, model: settings.model, language: settings.language, session: args.session ?? "once", logger: args.logger }) : undefined
  const timeline = tui ?? new TimelineRenderer(output, settings.language)
  const onEvent = timelineEventHandler(timeline)
  try {
    const controller = new AbortController()
    const permission = permissionService(args.mode, reader, () => controller.abort(), tui)
    const isTest = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
    const runnerInstance = createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger, permission, settings, onEvent, sessionId: args.session ?? "once", forcePlanning: true })
    const result = await runnerInstance.run(args.prompt, args.mode, { signal: controller.signal })
    timeline.finish()
    return { status: result.status, exitCode: result.status === "completed" ? 0 : 1 } satisfies CliRunResult
  } finally {
    reader.close()
  }
}

async function runSession(args: ReturnType<typeof parseArgs>, loadedEnvVars = 0) {
  const store = new SessionStore(args.root)
  const reader = new LineReader()
  const startupLanguage = configuredUiLanguage(process.env) ?? detectUiLanguage(process.env)
  const tui = args.tui ? new TuiRenderer(output, { root: args.root, mode: args.mode, provider: args.provider, model: args.model, language: startupLanguage, session: args.session, logger: args.logger }) : undefined
  let exitRequested = false
  let exitCode = 0
  let activeAbort: AbortController | undefined
  const onSigint = () => {
    if (exitRequested) {
      exitCode = 130
      activeAbort?.abort()
      reader.close()
      return
    }
    exitRequested = true
    activeAbort?.abort()
    reader.close()
  }
  process.on("SIGINT", onSigint)
  try {
    const selectedSession = await selectSession(args.session, store, reader, startupLanguage, tui)
    if (!selectedSession) return { status: "completed", exitCode } satisfies CliRunResult
    let session: string = selectedSession
    tui?.startSession(session)
    let logger = args.logger ? createLogger({ root: args.root, session }) : undefined
    emitLog(logger, { type: "data", name: "cli.args -> runner", detail: { mode: args.mode, provider: args.provider, root: args.root, session, promptMode: "interactive" } })
    emitLog(logger, { type: "data", name: ".env -> process.env", detail: { loadedEnvVars } })
    emitLog(logger, { type: "data", name: "session.selected", detail: { session } })

    const loadSessionState = async (sessionId: string) => {
      const nextContext = await store.context(sessionId)
      const storedSettings = await store.settings(sessionId, args.provider)
      const sessionData = await store.load(sessionId)
      let settings = normalizeSessionSettings({
        ...storedSettings,
        provider: args.providerExplicit ? args.provider : storedSettings.provider,
        model: args.model ?? storedSettings.model,
        maxTokens: args.maxTokens ?? storedSettings.maxTokens,
        maxSteps: args.maxSteps ?? storedSettings.maxSteps,
      }, args.provider)
      if (!args.providerExplicit && !storedSettings.provider) {
        settings = normalizeSessionSettings({ provider: args.provider, model: args.model, maxTokens: args.maxTokens, maxSteps: args.maxSteps }, args.provider)
      }
      return {
        context: nextContext,
        settings,
        tokenUsage: normalizeSessionTokenUsage(sessionData?.tokenUsage),
      }
    }

    let { context, settings: activeSettings, tokenUsage: sessionTokenUsage } = await loadSessionState(session)
    tui?.setSessionTokenUsage(sessionTokenUsage)
    await maybeShowWebSearchSetupHint(args.root, activeSettings.language, tui)
    const skillService = new SkillService(args.root)
    let pendingImages: ImagePart[] = []
    const queuedPrompts: string[] = []
    const queuedPromptImages: ImagePart[][] = []
    const enqueuePrompt = (text: string, images: ImagePart[] = []) => {
      queuedPrompts.push(text)
      queuedPromptImages.push(images)
    }
    const clearQueuedPrompts = () => {
      queuedPrompts.length = 0
      queuedPromptImages.length = 0
    }
    let activeMode: AgentMode = "build"
    let goalState: GoalState | undefined
    let runner: ReturnType<typeof createRunner> | undefined
    tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, language: activeSettings.language, session })
    const timeline = tui ?? new TimelineRenderer(output, activeSettings.language)

    const runMetrics: {
      current?: ProviderRunMetrics
      subagent: SessionTokenUsage
    } = {
      subagent: normalizeSessionTokenUsage(undefined),
    }
    const onEvent = (event: RunUiEvent) => {
      if (event.type === "provider_metrics" && event.metrics.source !== "subagent") {
        runMetrics.current = event.metrics
      }
      if (event.type === "subagent" && event.status === "completed" && event.metrics) {
        runMetrics.subagent = {
          ...runMetrics.subagent,
          subagentInputTokens: runMetrics.subagent.subagentInputTokens + event.metrics.inputTokens,
          subagentOutputTokens: runMetrics.subagent.subagentOutputTokens + event.metrics.outputTokens,
          subagentCalls: runMetrics.subagent.subagentCalls + event.metrics.calls,
          subagentCacheHitTokens: runMetrics.subagent.subagentCacheHitTokens + event.metrics.cacheHitTokens,
          subagentCacheMissTokens: runMetrics.subagent.subagentCacheMissTokens + event.metrics.cacheMissTokens,
        }
      }
      timeline.event(event)
    }

    let saveChain = Promise.resolve()
    const saveSession = (contextToSave: ContextManagerLike) => {
      saveChain = saveChain.then(() => store.save(session, contextToSave, activeSettings, sessionTokenUsage))
      return saveChain
    }
    const activeGoalAutomation = () => Boolean(goalState && (goalState.status === "defining" || goalState.status === "planning" || goalState.status === "executing" || goalState.status === "reviewing"))
    const syncGoalFromContext = () => {
      goalState = goalStateFromContext(context, goalState)
    }
    const emitGoalLifecycle = (name: string, goal: GoalState | undefined, extra: Record<string, unknown> = {}) => {
      if (!goal) return
      const phase = name.startsWith("goal.") ? name.slice(5) : name
      emitLog(logger, {
        type: "state",
        name,
        detail: {
          goalId: goal.id,
          objective: goal.objective,
          status: goal.status,
          iteration: goal.iteration,
          activePlanId: goal.activePlanId,
          blocker: goal.blocker,
          acceptanceCriteriaCount: goal.acceptanceCriteria.length,
          completionChecksCount: goal.completionChecks.length,
          ...extra,
        },
      })
      onEvent({
        type: "goal",
        phase: phase as "started" | "definition" | "planning" | "executing" | "reviewing" | "paused" | "blocked" | "completed" | "cleared",
        goal: {
          status: goal.status,
          objective: goal.objective,
          iteration: goal.iteration,
          activePlanId: goal.activePlanId,
          blocker: goal.blocker,
        },
      })
    }
    const syncTuiGoal = (goal: GoalState | undefined) => {
      tui?.setGoal(goal ? {
        status: goal.status,
        objective: goal.objective,
        iteration: goal.iteration,
        activePlanId: goal.activePlanId,
        blocker: goal.blocker,
      } : undefined)
    }
    const persistGoal = (next: GoalState | undefined) => {
      goalState = next
      if (goalState) {
        goalState = { ...goalState, activePlanId: currentPlanID(context), updatedAt: Date.now() }
        writeGoalState(context, goalState)
      } else {
        clearGoalState(context)
      }
      syncTuiGoal(goalState)
      runner = undefined
    }
    const clearActivePlanIfPresent = async () => {
      const planId = currentPlanID(context)
      if (planId) await PlanTracker.clearActivePlan(context, args.root, planId)
    }
    const beginGoalDefinition = (goal: GoalState, reason?: string) => {
      persistGoal({
        ...goal,
        status: "defining",
        blocker: undefined,
        activePlanId: undefined,
      })
      emitGoalLifecycle("goal.definition", goalState, reason ? { reason } : {})
      enqueuePrompt(buildGoalDefinitionPrompt(goalState ?? goal, reason))
    }
    const beginGoalPlanning = (goal: GoalState, reason?: string, advanceIteration = false) => {
      persistGoal({
        ...goal,
        status: "planning",
        blocker: undefined,
        iteration: advanceIteration ? goal.iteration + 1 : goal.iteration,
        activePlanId: undefined,
      })
      emitGoalLifecycle("goal.planning", goalState, {
        ...(reason ? { reason } : {}),
        advanceIteration,
      })
      enqueuePrompt(buildGoalPlanningPrompt(goalState ?? goal, reason))
    }
    const beginGoalReview = (goal: GoalState, reason?: string) => {
      persistGoal({
        ...goal,
        status: "reviewing",
        blocker: undefined,
        activePlanId: undefined,
      })
      emitGoalLifecycle("goal.reviewing", goalState, reason ? { reason } : {})
      enqueuePrompt(buildGoalAssessmentPrompt(goalState ?? goal, reason))
    }
    const pauseGoal = async (reason: string) => {
      if (!goalState) return
      await clearActivePlanIfPresent()
      persistGoal({ ...goalState, status: "paused", blocker: reason, activePlanId: undefined })
      emitGoalLifecycle("goal.paused", goalState, { reason })
      writeSessionMessage(`Goal paused.\n${goalStatusText(goalState)}`)
    }
    const blockGoal = async (reason: string) => {
      if (!goalState) return
      await clearActivePlanIfPresent()
      persistGoal({ ...goalState, status: "blocked", blocker: reason, activePlanId: undefined })
      emitGoalLifecycle("goal.blocked", goalState, { reason })
      writeSessionMessage(`Goal blocked.\n${goalStatusText(goalState)}`)
    }
    const completeGoal = (summary: string) => {
      if (!goalState) return
      persistGoal({ ...goalState, status: "completed", blocker: undefined, summary, activePlanId: undefined })
      emitGoalLifecycle("goal.completed", goalState, { summary })
      writeSessionMessage(`Goal completed.\n${goalAcceptanceText(goalState)}\n${summary}`)
    }
    const createSessionPermission = () => {
      if (!activeGoalAutomation()) return permissionService(activeMode, reader, () => activeAbort?.abort(), tui)
      return new PermissionService(defaultPermissionRules("goal"), async () => "reject" as const, defaultPermissionAutoReviewer)
    }
    const getRunner = () => {
      tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, language: activeSettings.language, session })
      const isTest = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
      runner ??= createRunner({ root: args.root, provider: activeSettings.provider, mode: activeMode, logger, context, permission: createSessionPermission(), settings: activeSettings, onEvent, onBackgroundContextUpdate: () => saveSession(context), sessionId: session, forcePlanning: true })
      return runner
    }
    const writeSessionMessage = (text: string) => writeCliText(tui, text, uiText(activeSettings.language).sessionTitle)
    const switchSession = async (nextSession: string) => {
      session = nextSession
      logger = args.logger ? createLogger({ root: args.root, session }) : undefined
      emitLog(logger, { type: "data", name: "session.selected", detail: { session } })
      const nextState = await loadSessionState(session)
      context = nextState.context
      activeSettings = nextState.settings
      sessionTokenUsage = nextState.tokenUsage
      pendingImages = []
      runMetrics.current = undefined
      runMetrics.subagent = normalizeSessionTokenUsage(undefined)
      runner = undefined
      goalState = undefined
      syncTuiGoal(undefined)
      clearQueuedPrompts()
      tui?.setSessionTokenUsage(sessionTokenUsage)
      tui?.startSession(session)
      tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, language: activeSettings.language, session })
      if (!tui) timeline.setLanguage?.(activeSettings.language)
    }

    while (true) {
      const queuedPrompt = queuedPrompts.shift()
      const queuedImages = queuedPrompt === undefined ? undefined : queuedPromptImages.shift() ?? []
      const prompt = (queuedPrompt ?? await question(reader, tui)).trim()
      if (prompt === eofPrompt) {
        const sessionContext = runner?.context ?? context
        await clearTransientSessionTaskState(sessionContext, args.root)
        await saveSession(sessionContext)
        return { status: "completed", exitCode } satisfies CliRunResult
      }
      if (["exit", ":exit", "quit", ":quit"].includes(prompt.toLowerCase())) {
        const sessionContext = runner?.context ?? context
        await clearTransientSessionTaskState(sessionContext, args.root)
        await saveSession(sessionContext)
        return { status: "completed", exitCode } satisfies CliRunResult
      }
      if (!prompt) continue
      const command = parseSlashCommand(prompt)
      if (command.type !== "prompt") {
        const changed = await handleSlashCommand(command, { root: args.root, settings: activeSettings, pendingImages, skills: skillService, sessions: store, currentSession: session, tui })
        activeSettings = changed.settings
        pendingImages = changed.pendingImages
        if (changed.goalAction) {
          if (changed.goalAction.action === "status") {
            syncGoalFromContext()
            writeSessionMessage(goalStatusText(goalState))
          } else if (changed.goalAction.action === "clear") {
            await clearActivePlanIfPresent()
            emitGoalLifecycle("goal.cleared", goalState)
            persistGoal(undefined)
            clearQueuedPrompts()
            writeSessionMessage("Goal cleared.")
          } else if (changed.goalAction.action === "pause") {
            if (!goalState) writeSessionMessage("No active goal.")
            else await pauseGoal(goalState.blocker ?? "Paused by user.")
          } else if (changed.goalAction.action === "resume") {
            if (!goalState) writeSessionMessage("No active goal.")
            else if (!goalHasAcceptance(goalState)) beginGoalDefinition(goalState, "Goal resumed by user. Define acceptance before planning.")
            else beginGoalPlanning(goalState, "Goal resumed by user.")
          } else if (changed.goalAction.action === "start") {
            await clearActivePlanIfPresent()
            const nextGoal = createGoalState(changed.goalAction.objective)
            clearQueuedPrompts()
            emitGoalLifecycle("goal.started", nextGoal)
            beginGoalDefinition(nextGoal, "Goal started by user. Define acceptance before any plan.")
            writeSessionMessage(`Goal started.\n${goalStatusText(goalState)}`)
          }
          await saveSession(runner?.context ?? context)
        } else if (changed.sessionAction?.type === "switch") {
          if (changed.sessionAction.target === session) {
            writeSessionMessage(uiText(activeSettings.language).sessionSwitchCurrent(session))
          } else {
            const sessionContext = runner?.context ?? context
            await clearTransientSessionTaskState(sessionContext, args.root)
            await saveSession(sessionContext)
            await switchSession(changed.sessionAction.target)
            writeSessionMessage(uiText(activeSettings.language).sessionSwitched(session))
          }
        } else if (changed.sessionAction?.type === "delete") {
          const target = changed.sessionAction.target
          if (target === session) {
            await saveSession(runner?.context ?? context)
          }
          const deleted = await store.delete(target)
          if (!deleted.existed) {
            writeSessionMessage(uiText(activeSettings.language).sessionNotFound(target))
          } else if (target === session) {
            const nextSession = (await store.list())[0]?.id ?? "default"
            await switchSession(nextSession)
            writeSessionMessage(uiText(activeSettings.language).sessionDeletedAndSwitched(target, session, deleted.archivedMemoryId ?? "memory"))
          } else {
            writeSessionMessage(uiText(activeSettings.language).sessionDeleted(target, deleted.archivedMemoryId ?? "memory"))
          }
        } else {
          tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, language: activeSettings.language, session })
          if (!tui) timeline.setLanguage?.(activeSettings.language)
          if (changed.resetRunner) runner = undefined
          await saveSession(runner?.context ?? context)
        }
        if (exitRequested) return { status: "completed", exitCode } satisfies CliRunResult
        continue
      }

      const activeRunner = getRunner()
      const images = queuedImages ?? pendingImages
      if (!queuedImages) pendingImages = []
      const messageCountBeforeRun = activeRunner.context.state.messages.length
      activeAbort = new AbortController()
      const runInput = collectRunInput(reader, activeAbort, { push: (text) => enqueuePrompt(text) }, tui)
      const result = await activeRunner.run(command.text, activeMode, { images, signal: activeAbort.signal })
      runInput.stop()
      activeAbort = undefined
      timeline.finish()
      const metrics = runMetrics.current
      const subagentUsage = runMetrics.subagent
      if (metrics) {
        sessionTokenUsage = {
          inputTokens: sessionTokenUsage.inputTokens + metrics.inputTokens,
          outputTokens: sessionTokenUsage.outputTokens + metrics.outputTokens,
          calls: sessionTokenUsage.calls + metrics.calls,
          subagentInputTokens: sessionTokenUsage.subagentInputTokens + subagentUsage.subagentInputTokens,
          subagentOutputTokens: sessionTokenUsage.subagentOutputTokens + subagentUsage.subagentOutputTokens,
          subagentCalls: sessionTokenUsage.subagentCalls + subagentUsage.subagentCalls,
          subagentCacheHitTokens: sessionTokenUsage.subagentCacheHitTokens + subagentUsage.subagentCacheHitTokens,
          subagentCacheMissTokens: sessionTokenUsage.subagentCacheMissTokens + subagentUsage.subagentCacheMissTokens,
        }
        tui?.setSessionTokenUsage(sessionTokenUsage)
      } else if (subagentUsage.subagentCalls > 0) {
        sessionTokenUsage = {
          ...sessionTokenUsage,
          subagentInputTokens: sessionTokenUsage.subagentInputTokens + subagentUsage.subagentInputTokens,
          subagentOutputTokens: sessionTokenUsage.subagentOutputTokens + subagentUsage.subagentOutputTokens,
          subagentCalls: sessionTokenUsage.subagentCalls + subagentUsage.subagentCalls,
          subagentCacheHitTokens: sessionTokenUsage.subagentCacheHitTokens + subagentUsage.subagentCacheHitTokens,
          subagentCacheMissTokens: sessionTokenUsage.subagentCacheMissTokens + subagentUsage.subagentCacheMissTokens,
        }
        tui?.setSessionTokenUsage(sessionTokenUsage)
      }
      runMetrics.current = undefined
      runMetrics.subagent = normalizeSessionTokenUsage(undefined)
      await saveSession(activeRunner.context)
      syncGoalFromContext()
      const recentToolResults = toolResultsSince(activeRunner.context.state.messages, messageCountBeforeRun)
      const goalAcceptanceResult = latestGoalAcceptanceResult(recentToolResults)
      const goalToolResult = latestGoalToolResult(recentToolResults)
      const deniedToolResult = firstDeniedToolResult(recentToolResults)
      const activePlanId = currentPlanID(activeRunner.context)
      const planStatus = currentPlanStatus(activeRunner.context)
      const planBlocker = currentPlanBlocker(activeRunner.context)
      if (exitRequested) return { status: "completed", exitCode } satisfies CliRunResult
      if (result.status === "completed" && hasProposedPlanText(result.text)) {
        savePlan(args.root, session, result.text).catch((err) => {
          emitLog(logger, { type: "error", name: "plan.save_failed", detail: { error: String(err) } })
          console.error("Failed to save plan file:", err)
        })

        const planId = activePlanId
        if (goalState?.status === "planning" || goalState?.status === "reviewing") {
          if (!planId) {
            await blockGoal("Goal planning returned a proposed plan, but no structured active plan was created.")
            await saveSession(activeRunner.context)
            continue
          }
          persistGoal(activateGoalPlan(goalState, planId))
          emitGoalLifecycle("goal.executing", goalState, { planId })
          await saveSession(activeRunner.context)
          enqueuePrompt("Proceed with the approved plan.")
          continue
        }

        let choice = "a"
        let isLowRisk = false
        if (planId) {
          try {
            const planState = await loadStructuredPlanState(args.root, session, planId)
            if (planState?.plan?.lowRisk) {
              isLowRisk = true
            }
          } catch {
            // ignore
          }
        }

        if (isLowRisk) {
          const autoApprovedMsg = uiText(tui?.getLanguage() ?? activeSettings.language ?? "en").planAutoApproved
          emitLog(logger, { type: "state", name: "plan.approval", detail: { planId, approval_source: "low_risk_auto", lowRisk: true } })
          if (tui) {
            tui.message(autoApprovedMsg)
          } else {
            console.log(autoApprovedMsg)
          }
        } else {
          const rawChoice = await reader.question(
            tui?.planApprovalPrompt() ?? "[A]pprove & execute  [R]eject (stay in plan)  [E]dit plan  [N]ew prompt [A]: "
          )
          choice = rawChoice.trim().toLowerCase() || "a"
          emitLog(logger, {
            type: "state",
            name: "plan.approval",
            detail: {
              planId,
              approval_source: rawChoice.trim() ? "user_explicit" : "user_default",
              choice,
              lowRisk: false,
            },
          })
          tui?.resumeAfterPrompt()
        }
        
        if (choice === "r" || choice.startsWith("reject")) {
          if (planId) {
            await PlanTracker.clearActivePlan(activeRunner.context, args.root, planId)
          }
          await saveSession(activeRunner.context)
          continue
        }
        if (choice === "e" || choice.startsWith("edit")) {
          const editDesc = await reader.question("What would you like changed? ")
          if (editDesc) enqueuePrompt(`Revise the plan: ${editDesc}`)
          await saveSession(activeRunner.context)
          continue
        }
        if (choice === "n" || choice.startsWith("new")) {
          if (planId) {
            await PlanTracker.clearActivePlan(activeRunner.context, args.root, planId)
          }
          await saveSession(activeRunner.context)
          continue
        }
        
        runner = undefined
        enqueuePrompt(planId ? "Proceed with the approved plan." : command.text, planId ? [] : images)
        continue
      }
      if (goalState) {
        if (goalAcceptanceResult) {
          syncGoalFromContext()
          if (!goalHasAcceptance(goalState)) {
            await blockGoal("Goal acceptance recording finished without durable acceptance criteria.")
            await saveSession(activeRunner.context)
            continue
          }
          beginGoalPlanning(goalState, "Goal acceptance criteria were recorded. Plan the first bounded slice.")
          await saveSession(activeRunner.context)
          continue
        }
        if (goalToolResult?.toolName === "goal_complete") {
          completeGoal(String(goalToolResult.metadata.summary ?? goalToolResult.output).trim() || "Goal completed.")
          await saveSession(activeRunner.context)
          continue
        }
        if (goalToolResult?.toolName === "goal_blocked") {
          await blockGoal(String(goalToolResult.metadata.reason ?? goalToolResult.output).trim() || "Goal blocked.")
          await saveSession(activeRunner.context)
          continue
        }
        if (deniedToolResult && activeGoalAutomation()) {
          await pauseGoal(`Permission denied for ${deniedToolResult.toolName}. Resume after user intervention or revise the goal plan.`)
          await saveSession(activeRunner.context)
          continue
        }
        if (planStatus === "blocked" && (goalState.status === "planning" || goalState.status === "executing" || goalState.status === "reviewing")) {
          await blockGoal(planBlocker ?? "The active goal plan became blocked.")
          await saveSession(activeRunner.context)
          continue
        }
        if (result.status === "completed" && goalState.status === "defining") {
          await blockGoal("Goal definition ended without recording acceptance criteria or an explicit blocked state.")
          await saveSession(activeRunner.context)
          continue
        }
        if (result.status === "completed" && goalState.status === "planning") {
          await blockGoal("Goal planning ended without a proposed plan or an explicit goal resolution.")
          await saveSession(activeRunner.context)
          continue
        }
        if (result.status === "completed" && goalState.status === "executing" && !activePlanId) {
          beginGoalReview(goalState, "The previous goal slice completed. Review and verify the goal before deciding whether to complete it or plan the next slice.")
          await saveSession(activeRunner.context)
          continue
        }
        if (result.status === "completed" && goalState.status === "reviewing") {
          await blockGoal("Goal review ended without a completion decision or a next bounded plan.")
          await saveSession(activeRunner.context)
          continue
        }
      }
      if (result.status !== "completed") continue
    }
  } finally {
    process.off("SIGINT", onSigint)
    reader.close()
  }
}

function timelineEventHandler(timeline: { event(event: RunUiEvent): void }) {
  return (event: RunUiEvent) => {
    timeline.event(event)
  }
}

function currentPlanID(context: ContextManagerLike) {
  return currentLedgerValue(context, "current_plan_id")
}

function currentPlanStatus(context: ContextManagerLike) {
  return currentLedgerValue(context, "plan_lifecycle_status")
}

function currentPlanBlocker(context: ContextManagerLike) {
  const blocker = currentLedgerValue(context, "plan_blocker")
  return blocker && blocker !== "none" ? blocker : undefined
}

function currentLedgerValue(context: ContextManagerLike, subject: string) {
  return context.state.ledger?.current.find((record) => record.subject === subject && record.status === "current")?.value
}

function toolResultsSince(messages: Message[], startIndex: number) {
  const results: Array<{ toolName: string; output: string; metadata: Record<string, unknown>; status: string }> = []
  for (const message of messages.slice(startIndex)) {
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue
      results.push({ toolName: part.toolName, output: part.output, metadata: part.metadata, status: part.status })
    }
  }
  return results
}

function firstDeniedToolResult(results: ReturnType<typeof toolResultsSince>) {
  return results.find((result) => result.status === "denied")
}

function latestGoalToolResult(results: ReturnType<typeof toolResultsSince>) {
  return [...results].reverse().find((result) => result.toolName === "goal_complete" || result.toolName === "goal_blocked")
}

function latestGoalAcceptanceResult(results: ReturnType<typeof toolResultsSince>) {
  return [...results].reverse().find((result) => result.toolName === "goal_set_acceptance" && result.status === "succeeded")
}

async function clearTransientSessionTaskState(context: ContextManagerLike, root: string) {
  const planId = currentPlanID(context)
  if (planId) await PlanTracker.clearActivePlan(context, root, planId)
  const goal = goalStateFromContext(context)
  if (goal && goal.status !== "completed") clearGoalState(context)
}

if (import.meta.main) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(formatCliError(error))
    return 1
  })
}

export { parseArgs }
