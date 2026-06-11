#!/usr/bin/env bun
import path from "node:path"
import { stdout as output } from "node:process"
import { createRunner, hasProposedPlanText } from "./agent"
import type { ContextManagerLike } from "./context"
import { createLogger, emitLog } from "./logger"
import { detectUiLanguage, uiText } from "./i18n"
import type { AgentMode, ImagePart } from "./message"
import { textMessage } from "./message"
import { savePlan } from "./plans"
import { PlanTracker } from "./agent/planner"
import { hasProvider, listProviders } from "./provider"
import { SessionStore, type SessionTokenUsage } from "./session"
import { normalizeSessionSettings } from "./settings"
import { parseSlashCommand } from "./slash"
import { SkillService } from "./skill"
import { LineReader, eofPrompt } from "./cli/line-reader"
import { activeTaskCheckpoints, collectRunInput, formatTaskCheckpointsBlock, handleSlashCommand, maybeShowWebSearchSetupHint, permissionService, question, selectSession, writeCliText } from "./cli/session-helpers"
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

  const status = args.once ? await runOnce(args, loadedEnvVars) : await runSession(args, loadedEnvVars)
  return status === "completed" ? 0 : 1
}

function formatCliError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  if (!trimmed) return "easycode failed. Please try again."
  if (trimmed.startsWith("Usage:")) return trimmed
  return `easycode failed: ${trimmed}`
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
    const runnerInstance = createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger, permission, settings, onEvent, sessionId: args.session ?? "once" })
    const result = await runnerInstance.run(args.prompt, args.mode, { signal: controller.signal })
    timeline.finish()
    return result.status
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
  let activeAbort: AbortController | undefined
  const onSigint = () => {
    if (exitRequested) {
      process.exit(130)
    }
    exitRequested = true
    activeAbort?.abort()
    reader.close()
  }
  process.on("SIGINT", onSigint)
  try {
    const selectedSession = await selectSession(args.session, store, reader, startupLanguage, tui)
    if (!selectedSession) return "completed"
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
        tokenUsage: sessionData?.tokenUsage ?? { inputTokens: 0, outputTokens: 0, calls: 0 },
      }
    }

    let { context, settings: activeSettings, tokenUsage: sessionTokenUsage } = await loadSessionState(session)
    tui?.setSessionTokenUsage(sessionTokenUsage)
    await maybeShowWebSearchSetupHint(args.root, activeSettings.language, tui)
    await showAndInjectTaskCheckpoints(args.root, activeSettings, context, tui)
    const skillService = new SkillService(args.root)
    let pendingImages: ImagePart[] = []
    const queuedPrompts: string[] = []
    let activeMode: AgentMode = "build"
    let runner: ReturnType<typeof createRunner> | undefined
    tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, language: activeSettings.language, session })
    const timeline = tui ?? new TimelineRenderer(output, activeSettings.language)

    const runMetrics: { current?: ProviderRunMetrics } = {}
    const onEvent = (event: RunUiEvent) => {
      if (event.type === "provider_metrics") {
        runMetrics.current = event.metrics
      }
      timeline.event(event)
    }

    let saveChain = Promise.resolve()
    const saveSession = (contextToSave: ContextManagerLike) => {
      saveChain = saveChain.then(() => store.save(session, contextToSave, activeSettings, sessionTokenUsage))
      return saveChain
    }
    const getRunner = () => {
      tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, language: activeSettings.language, session })
      runner ??= createRunner({ root: args.root, provider: activeSettings.provider, mode: activeMode, logger, context, permission: permissionService(activeMode, reader, () => activeAbort?.abort(), tui), settings: activeSettings, onEvent, onBackgroundContextUpdate: () => saveSession(context), sessionId: session })
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
      runner = undefined
      queuedPrompts.length = 0
      tui?.setSessionTokenUsage(sessionTokenUsage)
      tui?.startSession(session)
      tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, language: activeSettings.language, session })
      if (!tui) timeline.setLanguage?.(activeSettings.language)
      await showAndInjectTaskCheckpoints(args.root, activeSettings, context, tui)
    }

    while (true) {
      const prompt = (queuedPrompts.shift() ?? await question(reader, tui)).trim()
      if (prompt === eofPrompt) {
        await saveSession(runner?.context ?? context)
        return "completed"
      }
      if (["exit", ":exit", "quit", ":quit"].includes(prompt.toLowerCase())) {
        await saveSession(runner?.context ?? context)
        return "completed"
      }
      if (!prompt) continue
      const command = parseSlashCommand(prompt)
      if (command.type !== "prompt") {
        const changed = await handleSlashCommand(command, { root: args.root, settings: activeSettings, pendingImages, skills: skillService, sessions: store, currentSession: session, tui })
        activeSettings = changed.settings
        pendingImages = changed.pendingImages
        if (changed.sessionAction?.type === "switch") {
          if (changed.sessionAction.target === session) {
            writeSessionMessage(uiText(activeSettings.language).sessionSwitchCurrent(session))
          } else {
            await saveSession(runner?.context ?? context)
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
        if (exitRequested) return "completed"
        continue
      }

      const activeRunner = getRunner()
      const images = pendingImages
      pendingImages = []
      activeAbort = new AbortController()
      const runInput = collectRunInput(reader, activeAbort, queuedPrompts, tui)
      const result = await activeRunner.run(command.text, activeMode, { images, signal: activeAbort.signal })
      runInput.stop()
      activeAbort = undefined
      timeline.finish()
      const metrics = runMetrics.current
      if (metrics) {
        sessionTokenUsage = {
          inputTokens: sessionTokenUsage.inputTokens + metrics.inputTokens,
          outputTokens: sessionTokenUsage.outputTokens + metrics.outputTokens,
          calls: sessionTokenUsage.calls + metrics.calls,
        }
        tui?.setSessionTokenUsage(sessionTokenUsage)
      }
      runMetrics.current = undefined
      await saveSession(activeRunner.context)
      if (exitRequested) return "completed"
      if (result.status === "completed" && hasProposedPlanText(result.text)) {
        savePlan(args.root, session, result.text).catch((err) => {
          emitLog(logger, { type: "error", name: "plan.save_failed", detail: { error: String(err) } })
          console.error("Failed to save plan file:", err)
        })
        
        const planIdRecord = activeRunner.context.state.ledger?.current.find(r => r.subject === "current_plan_id" && r.status === "current")
        const planId = planIdRecord?.value
        const choice = (await reader.question(
          tui?.planApprovalPrompt() ?? "[A]pprove & execute  [R]eject (stay in plan)  [E]dit plan  [N]ew prompt [A]: "
        )).trim().toLowerCase() || "a"
        tui?.resumeAfterPrompt()
        
        if (choice === "r" || choice.startsWith("reject")) {
          if (planId) {
            await PlanTracker.clearActivePlan(activeRunner.context, args.root, planId)
          }
          await saveSession(activeRunner.context)
          continue
        }
        if (choice === "e" || choice.startsWith("edit")) {
          if (planId) {
            await PlanTracker.clearActivePlan(activeRunner.context, args.root, planId)
          }
          await saveSession(activeRunner.context)
          const editDesc = await reader.question("What would you like changed? ")
          if (editDesc) queuedPrompts.push(`Revise the plan: ${editDesc}`)
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
        queuedPrompts.push(planId ? "Proceed with the approved plan." : command.text)
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

async function showAndInjectTaskCheckpoints(root: string, settings: { language: import("./settings").SessionSettings["language"] }, context: ContextManagerLike, tui?: TuiRenderer) {
  const records = await activeTaskCheckpoints(root)
  if (records.length === 0) return
  const copy = uiText(settings.language)
  const lines = [copy.activeTaskCheckpoints, ...records.map((record) => `  ${record.id} [${record.kind}]: ${record.text}`)]
  writeCliText(tui, lines.join("\n"), copy.taskTitle)
  const block = formatTaskCheckpointsBlock(records)
  if (!block) return
  if (context.state.messages.some((message) => message.role === "system" && message.parts.some((part) => part.type === "text" && part.text.includes("<active_task_checkpoints>")))) return
  context.add(textMessage("system", block))
}

if (import.meta.main) {
  const exitCode = await main().catch((error: unknown) => {
    console.error(formatCliError(error))
    return 1
  })
  process.exit(exitCode)
}

export { parseArgs }
