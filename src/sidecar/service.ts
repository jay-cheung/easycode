import { createRunner, hasProposedPlanText } from "../agent"
import { attachedFileFromInput, promptWithAttachedFiles } from "../attachment"
import { ContextManager, type ContextManagerLike } from "../context"
import { GoalFlowController, type QueuedControllerPrompt } from "../controller"
import { currentPlanBlocker, currentPlanID, currentPlanStatus } from "../controller"
import { goalStateFromContext, goalStatusText } from "../goal"
import { imageLabel, imagePartFromInput } from "../image"
import { createLogger, emitLog, type Logger } from "../logger"
import type { AgentMode, ImagePart } from "../message"
import { languageDisplay, parseUiLanguage, supportedLanguageSummary, uiText } from "../i18n"
import { defaultPermissionAutoReviewer, defaultPermissionRules, PermissionRejectedError, PermissionService, type PermissionReply, type PermissionRequest } from "../permission"
import { loadStructuredPlanState, savePlan } from "../plans"
import { PlanTracker } from "../agent/planner"
import { createProvider, defaultProviderCapabilities, diagnoseProviderReadiness, hasProvider, listProviders } from "../provider"
import { normalizeSessionTokenUsage, SessionStore, type SessionTokenUsage } from "../session"
import { defaultSessionSettings, isReasoningEffort, normalizeSessionSettings, type SessionSettings } from "../settings"
import { SkillService } from "../skill"
import { parseSlashCommand, slashHelpText, type SlashCommand } from "../slash"
import { loadEnvFile } from "../cli/startup"
import type { ProviderRunMetrics, RunUiEvent } from "../ui/timeline"
import { SidecarProtocolError } from "./jsonl"
import { parseExecuteSlashCommandParams, parseGoalControlParams, parseInitializeParams, parseReplyPermissionParams, parseReplyPlanParams, parseRunPromptParams, parseSessionParam, parseUpdateSettingsParams } from "./params"
import { slashResultShouldPersist } from "./slash-result"
import { sidecarProtocolVersion, type RunPromptMode, type RunPromptPermissionMode, type SidecarEvent, type SidecarEventEnvelope, type SidecarRequest, type SidecarSlashCommandResult } from "./types"

type Writer = (event: SidecarEventEnvelope) => void

type PendingPermission = {
  resolve: (reply: PermissionReply) => void
}

type PendingPlan = {
  resolve: (reply: { action: "approve" | "reject" | "edit" | "new_prompt"; text?: string }) => void
}

type ActiveRun = {
  id: string
  abort: AbortController
  pendingPlan?: PendingPlan
}

export class SidecarService {
  private root = process.cwd()
  private session = "default"
  private settings: SessionSettings = defaultSessionSettings()
  private loadedEnvVars = 0
  private activeRun: ActiveRun | undefined
  private readonly pendingPermissions = new Map<string, PendingPermission>()

  constructor(private readonly writeEvent: Writer) {}

  async handle(request: SidecarRequest) {
    switch (request.method) {
      case "initialize": return await this.initialize(request.params)
      case "listProviders": return { providers: listProviders(), currentProvider: this.settings.provider }
      case "getProviderReadiness": return await this.providerReadiness()
      case "listSkills": return await this.listSkills()
      case "listSessions": return { sessions: await this.store().list(), currentSession: this.session }
      case "loadSession": return await this.loadSession(request.params)
      case "deleteSession": return await this.deleteSession(request.params)
      case "getGoalStatus": return await this.getGoalStatus(request.params)
      case "pauseGoal": return await this.pauseGoal(request.params)
      case "resumeGoal": return await this.resumeGoal(request.params)
      case "clearGoal": return await this.clearGoal(request.params)
      case "getPlanStatus": return await this.getPlanStatus(request.params)
      case "clearPlan": return await this.clearPlan(request.params)
      case "getSettings": return { root: this.root, session: this.session, settings: this.settings }
      case "updateSettings": return await this.updateSettings(request.params)
      case "executeSlashCommand": return await this.executeSlashCommand(request.params)
      case "runPrompt": return await this.runPrompt(request.params)
      case "cancelRun": return this.cancelRun()
      case "replyPermission": return this.replyPermission(request.params)
      case "replyPlan": return this.replyPlan(request.params)
      case "shutdown": return { shuttingDown: true }
    }
  }

  private async initialize(params: unknown) {
    const parsed = parseInitializeParams(params, this.root, this.settings)
    this.root = parsed.root
    this.session = parsed.session
    this.settings = parsed.settings
    this.loadedEnvVars = await loadEnvFile(this.root)
    this.emit({ type: "session_changed", session: this.session })
    return { protocolVersion: sidecarProtocolVersion, root: this.root, session: this.session, settings: this.settings }
  }

  private async loadSession(params: unknown) {
    const session = parseSessionParam(params, this.session)
    const loaded = await this.store().load(session)
    const settings = await this.store().settings(session, this.settings.provider)
    return { session: loaded, messages: loaded?.messages ?? [], settings }
  }

  private async listSkills() {
    const skills = await new SkillService(this.root).available()
    return {
      skills,
      selectedSkills: [...(this.settings.selectedSkills ?? [])],
      pendingSkillLoads: [...(this.settings.pendingSkillLoads ?? [])],
    }
  }

  private async deleteSession(params: unknown) {
    const target = parseSessionParam(params, this.session)
    const store = this.store()
    const deleted = await store.delete(target)
    if (target !== this.session || !deleted.existed) return deleted
    const next = (await store.list()).at(0)?.id ?? "default"
    this.session = next
    this.settings = await this.sessionSettings(store, next)
    if (next === "default") await this.persistCurrentSettings()
    this.emit({ type: "session_changed", session: next })
    return { ...deleted, currentSession: next }
  }

  private async providerReadiness() {
    await loadEnvFile(this.root)
    return diagnoseProviderReadiness(this.settings.provider, process.env, {
      model: this.settings.model,
      thinking: this.settings.thinking,
      effort: this.settings.effort,
    })
  }

  private async getGoalStatus(params: unknown) {
    const session = parseSessionParam(params, this.session)
    const context = await this.rawSessionContext(session)
    const goal = goalStateFromContext(context)
    return { ...(goal ? { goal } : {}), text: goalStatusText(goal) }
  }

  private async clearGoal(params: unknown) {
    const session = parseSessionParam(params, this.session)
    const store = this.store()
    const loaded = await store.load(session)
    if (!loaded) return { cleared: false, text: "No active goal." }
    const context = await this.rawSessionContext(session)
    const before = goalStateFromContext(context)
    if (!before) return { cleared: false, text: "No active goal." }
    const settings = await this.sessionSettings(store, session)
    await new GoalFlowController({ root: this.root, session, context }).clear()
    await store.save(session, context, settings, normalizeSessionTokenUsage(loaded.tokenUsage))
    this.emit({ type: "goal", phase: "cleared", goal: { status: before.status, objective: before.objective, iteration: before.iteration, activePlanId: before.activePlanId, blocker: before.blocker } })
    return { cleared: true, text: "Goal cleared." }
  }

  private async pauseGoal(params: unknown) {
    const input = parseGoalControlParams(params, this.session)
    const store = this.store()
    const loaded = await store.load(input.session)
    if (!loaded) return { paused: false, text: "No active goal." }
    const context = await this.rawSessionContext(input.session)
    const before = goalStateFromContext(context)
    if (!before) return { paused: false, text: "No active goal." }
    const settings = await this.sessionSettings(store, input.session)
    const messages: string[] = []
    await new GoalFlowController({
      root: this.root,
      session: input.session,
      context,
      onEvent: (event) => this.emit(event),
      writeMessage: (text) => messages.push(text),
    }).pause(input.reason)
    await store.save(input.session, context, settings, normalizeSessionTokenUsage(loaded.tokenUsage))
    const goal = goalStateFromContext(context)
    return { paused: true, ...(goal ? { goal } : {}), text: messages.at(-1) ?? goalStatusText(goal) }
  }

  private async resumeGoal(params: unknown) {
    if (this.activeRun) throw new SidecarProtocolError("run_in_progress", "Only one active sidecar run is supported in v1.")
    const input = parseGoalControlParams(params, this.session)
    const runId = nextRunId()
    this.session = input.session
    this.emit({ type: "session_changed", session: input.session })
    const abort = new AbortController()
    this.activeRun = { id: runId, abort }
    try {
      const store = this.store()
      const context = await this.rawSessionContext(input.session)
      const settings = await this.sessionSettings(store, input.session)
      const logger = createLogger({ root: this.root, session: input.session })
      const usage = normalizeSessionTokenUsage((await store.load(input.session))?.tokenUsage)
      const controller = new GoalFlowController({
        root: this.root,
        session: input.session,
        context,
        logger,
        onEvent: (event) => this.emit(event, runId),
      })
      const queued = controller.resume()
      if (!queued) {
        await store.save(input.session, context, settings, usage)
        this.emit({ type: "run_done", status: "cancelled" }, runId)
        return { runId, status: "cancelled", text: controller.statusText(), usage }
      }
      return { runId, ...await this.executeGoalQueue(runId, input.session, context, settings, usage, logger, queued, abort) }
    } finally {
      this.pendingPermissions.clear()
      if (this.activeRun?.id === runId) this.activeRun = undefined
    }
  }

  private async getPlanStatus(params: unknown) {
    const session = parseSessionParam(params, this.session)
    const context = await this.rawSessionContext(session)
    const planId = currentPlanID(context)
    if (!planId) return { text: "No active plan." }
    const plan = await loadStructuredPlanState(this.root, session, planId)
    const status = currentPlanStatus(context) ?? plan?.checkpoint.status
    const currentStepId = plan?.checkpoint.currentStepId
    const blocker = currentPlanBlocker(context) ?? plan?.checkpoint.blocker
    return {
      planId,
      ...(plan ? { plan } : {}),
      ...(status ? { status } : {}),
      ...(currentStepId ? { currentStepId } : {}),
      ...(blocker ? { blocker } : {}),
      text: planStatusText(planId, plan, status, currentStepId, blocker),
    }
  }

  private async clearPlan(params: unknown) {
    const session = parseSessionParam(params, this.session)
    const store = this.store()
    const loaded = await store.load(session)
    if (!loaded) return { cleared: false, text: "No active plan." }
    const context = await this.rawSessionContext(session)
    const planId = currentPlanID(context)
    if (!planId) return { cleared: false, text: "No active plan." }
    await PlanTracker.clearActivePlan(context, this.root, planId)
    const settings = await this.sessionSettings(store, session)
    await store.save(session, context, settings, normalizeSessionTokenUsage(loaded.tokenUsage))
    return { cleared: true, planId, text: "Plan cleared." }
  }

  private async updateSettings(params: unknown) {
    const input = parseUpdateSettingsParams(params)
    const nextSession = typeof input.session === "string" && input.session.trim() ? input.session.trim() : this.session
    const provider = typeof input.provider === "string" && input.provider ? input.provider : this.settings.provider
    if (!hasProvider(provider)) {
      throw new SidecarProtocolError("invalid_params", `Unknown provider: ${provider}. Available providers: ${listProviders().join(", ")}`)
    }
    this.settings = normalizeSessionSettings({ ...this.settings, ...input, provider }, provider)
    if (nextSession !== this.session) {
      this.session = nextSession
      this.emit({ type: "session_changed", session: this.session })
    }
    await this.persistCurrentSettings()
    return { settings: this.settings }
  }

  private async executeSlashCommand(params: unknown): Promise<SidecarSlashCommandResult> {
    const input = parseExecuteSlashCommandParams(params)
    const command = parseSlashCommand(input.text)
    if (command.type === "prompt") return { handled: false, promptText: command.text }
    const copy = uiText(this.settings.language)
    const result = (title: string, text: string, extra: Partial<Extract<SidecarSlashCommandResult, { handled: true }>> = {}): SidecarSlashCommandResult => ({
      handled: true,
      title,
      text,
      ...extra,
    })

    switch (command.type) {
      case "help":
        return result(copy.helpTitle, slashHelpText(this.settings.language))
      case "settings":
        return result(copy.settingsTitle, this.settingsText(input.pendingImages ?? 0, input.pendingFiles ?? 0))
      case "cancel": {
        const cancelled = this.cancelRun() as { cancelled: boolean; runId?: string }
        return result(copy.commandTitle, cancelled.cancelled ? copy.cancellingRun : "No active run.")
      }
      case "sessions":
        return result(copy.sessionsTitle, await sessionsText(this.store(), this.session, this.settings.language))
      case "unknown":
        return result(copy.commandTitle, copy.commandUnknown(command.name))
      case "error":
        return result(copy.commandTitle, copy.slashError(command.code))
      case "plan":
        return { handled: false, promptText: command.objective, mode: "plan" }
      case "goal": {
        if (command.action === "start") return { handled: false, promptText: command.objective, mode: "goal" }
        if (command.action === "status") {
          const status = await this.getGoalStatus({})
          return result(copy.goalModeTitle, String((status as { text: string }).text))
        }
        if (command.action === "pause") {
          const paused = await this.pauseGoal({})
          return result(copy.goalModeTitle, String((paused as { text: string }).text))
        }
        if (command.action === "clear") {
          const cleared = await this.clearGoal({})
          return result(copy.goalModeTitle, String((cleared as { text: string }).text))
        }
        return result(copy.goalModeTitle, "Resuming goal.", { action: { type: "resumeGoal" } })
      }
      case "session":
        return await this.finalizeSlashResult(await this.executeSessionSlash(command.action, command.target))
      case "model":
        this.settings = normalizeSessionSettings({ ...this.settings, model: command.model }, this.settings.provider)
        return await this.finalizeSlashResult(result(copy.modelTitle, command.model ? copy.modelSet(command.model) : copy.modelReset, { settings: this.settings }))
      case "provider":
        if (!hasProvider(command.name)) return result(copy.providerTitle, copy.providerUnknown(command.name, listProviders().join(", ")))
        this.settings = normalizeSessionSettings({ ...this.settings, provider: command.name, model: undefined }, command.name)
        return await this.finalizeSlashResult(result(copy.providerTitle, copy.providerSet(command.name), { settings: this.settings }))
      case "maxTokens":
        this.settings = normalizeSessionSettings({ ...this.settings, maxTokens: command.value }, this.settings.provider)
        return await this.finalizeSlashResult(result(copy.settingsTitle, copy.maxTokensSet(this.settings.maxTokens ?? 0), { settings: this.settings }))
      case "maxSteps":
        this.settings = normalizeSessionSettings({ ...this.settings, maxSteps: command.value }, this.settings.provider)
        return await this.finalizeSlashResult(result(copy.settingsTitle, copy.maxStepsSet(this.settings.maxSteps ?? 0), { settings: this.settings }))
      case "lang": {
        if (!command.value) {
          return result(copy.languageTitle, copy.languageCurrent(languageDisplay(this.settings.language), supportedLanguageSummary()))
        }
        const selected = parseUiLanguage(command.value)
        if (!selected) return result(copy.languageTitle, copy.languageInvalid(command.value, supportedLanguageSummary()))
        this.settings = normalizeSessionSettings({ ...this.settings, language: selected }, this.settings.provider)
        return await this.finalizeSlashResult(result(uiText(selected).languageTitle, uiText(selected).languageUpdated(languageDisplay(selected), "current session"), { settings: this.settings }))
      }
      case "thinking": {
        const provider = createProvider(this.settings.provider, { model: this.settings.model, thinking: this.settings.thinking, effort: this.settings.effort })
        if (!(provider.capabilities ?? defaultProviderCapabilities).supportsThinking) return result(copy.thinkingTitle, copy.providerThinkingUnsupported(this.settings.provider))
        this.settings = normalizeSessionSettings({ ...this.settings, thinking: command.value === "on" }, this.settings.provider)
        return await this.finalizeSlashResult(result(copy.thinkingTitle, copy.thinkingUpdated(this.settings.thinking, Boolean(command.aliasUsed)), { settings: this.settings }))
      }
      case "effort": {
        if (!isReasoningEffort(command.value)) return result(copy.effortTitle, copy.slashError("effort_requires_value"))
        const provider = createProvider(this.settings.provider, { model: this.settings.model, thinking: this.settings.thinking, effort: this.settings.effort })
        if (!(provider.capabilities ?? defaultProviderCapabilities).supportsReasoningEffort) return result(copy.effortTitle, copy.providerEffortUnsupported(this.settings.provider))
        this.settings = normalizeSessionSettings({ ...this.settings, effort: command.value }, this.settings.provider)
        return await this.finalizeSlashResult(result(copy.effortTitle, copy.effortUpdated(this.settings.effort, this.settings.thinking), { settings: this.settings }))
      }
      case "image":
        return await this.executeImageSlash(command.action, command.action === "add" ? command.value : undefined)
      case "file":
        return await this.executeFileSlash(command.action, command.action === "add" ? command.value : undefined)
      case "skill":
        return await this.finalizeSlashResult(await this.executeSkillSlash(command))
    }
  }

  private async finalizeSlashResult(result: SidecarSlashCommandResult) {
    if (slashResultShouldPersist(result)) await this.persistCurrentSettings()
    return result
  }

  private async runPrompt(params: unknown) {
    if (this.activeRun) throw new SidecarProtocolError("run_in_progress", "Only one active sidecar run is supported in v1.")
    const input = parseRunPromptParams(params)
    const runId = nextRunId()
    const session = input.session ?? this.session
    this.session = session
    this.emit({ type: "session_changed", session })
    const abort = new AbortController()
    this.activeRun = { id: runId, abort }
    try {
      const result = await this.executePrompt(runId, session, input.text, input.mode ?? "build", input.permissionMode ?? "ask", input.images ?? [], input.files ?? [], abort)
      return { runId, ...result }
    } finally {
      this.pendingPermissions.clear()
      if (this.activeRun?.id === runId) this.activeRun = undefined
    }
  }

  private cancelRun() {
    const run = this.activeRun
    if (!run) return { cancelled: false }
    run.abort.abort()
    run.pendingPlan?.resolve({ action: "reject" })
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve("reject")
      this.pendingPermissions.delete(requestId)
    }
    return { cancelled: true, runId: run.id }
  }

  private replyPermission(params: unknown) {
    const input = parseReplyPermissionParams(params)
    const pending = this.pendingPermissions.get(input.requestId)
    if (!pending) throw new SidecarProtocolError("permission_not_found", "No pending permission request exists for requestId.")
    pending.resolve(input.reply)
    this.pendingPermissions.delete(input.requestId)
    return { accepted: true }
  }

  private replyPlan(params: unknown) {
    const input = parseReplyPlanParams(params)
    if (this.activeRun?.id !== input.runId || !this.activeRun.pendingPlan) throw new SidecarProtocolError("plan_not_found", "No pending plan approval exists for runId.")
    this.activeRun.pendingPlan.resolve({ action: input.action, text: input.text })
    this.activeRun.pendingPlan = undefined
    return { accepted: true }
  }

  private async executeSessionSlash(action: "switch" | "delete", target: string): Promise<SidecarSlashCommandResult> {
    const copy = uiText(this.settings.language)
    const store = this.store()
    const sessions = await store.list()
    const exists = sessions.some((session) => session.id === target)
    if (action === "switch") {
      if (target === this.session) return { handled: true, title: copy.sessionsTitle, text: copy.sessionSwitchCurrent(target), session: this.session }
      await this.persistCurrentSettings()
      this.session = target
      this.settings = await this.sessionSettings(store, target)
      if (!exists) await this.persistCurrentSettings()
      this.emit({ type: "session_changed", session: target })
      return { handled: true, title: copy.sessionsTitle, text: copy.sessionSwitched(target), settings: this.settings, session: target }
    }
    if (!exists) return { handled: true, title: copy.sessionsTitle, text: copy.sessionNotFound(target) }
    await store.delete(target)
    if (target !== this.session) return { handled: true, title: copy.sessionsTitle, text: copy.sessionDeleted(target, target) }
    const next = (await store.list()).at(0)?.id ?? "default"
    this.session = next
    this.settings = await this.sessionSettings(store, next)
    if (next === "default") await this.persistCurrentSettings()
    this.emit({ type: "session_changed", session: next })
    return { handled: true, title: copy.sessionsTitle, text: copy.sessionDeletedAndSwitched(target, next, target), settings: this.settings, session: next }
  }

  private async executeImageSlash(action: "add" | "clear", value: string | undefined): Promise<SidecarSlashCommandResult> {
    const copy = uiText(this.settings.language)
    if (action === "clear") return { handled: true, title: copy.imageTitle, text: copy.pendingImagesCleared, action: { type: "clearImages" } }
    if (!value) return { handled: true, title: copy.imageTitle, text: copy.slashError("image_requires_value") }
    const provider = createProvider(this.settings.provider, { model: this.settings.model, thinking: this.settings.thinking, effort: this.settings.effort })
    if (!(provider.capabilities ?? defaultProviderCapabilities).supportsImages) {
      return { handled: true, title: copy.imageTitle, text: copy.providerImageUnsupported(this.settings.provider) }
    }
    try {
      const part = await imagePartFromInput(value, this.root)
      const label = imageLabel(part.source)
      return { handled: true, title: copy.imageTitle, text: copy.imageAttached(label), action: { type: "addImage", path: value, label } }
    } catch (error) {
      return { handled: true, title: copy.imageTitle, text: error instanceof Error ? error.message : String(error) }
    }
  }

  private async executeFileSlash(action: "add" | "clear", value: string | undefined): Promise<SidecarSlashCommandResult> {
    const copy = uiText(this.settings.language)
    if (action === "clear") return { handled: true, title: copy.fileTitle, text: copy.pendingFilesCleared, action: { type: "clearFiles" } }
    if (!value) return { handled: true, title: copy.fileTitle, text: copy.slashError("file_requires_value") }
    try {
      const file = await attachedFileFromInput(this.root, value)
      return { handled: true, title: copy.fileTitle, text: copy.fileAttached(file.relativePath), action: { type: "addFile", path: file.path, label: file.relativePath } }
    } catch (error) {
      return { handled: true, title: copy.fileTitle, text: error instanceof Error ? error.message : String(error) }
    }
  }

  private async executeSkillSlash(command: Extract<SlashCommand, { type: "skill" }>): Promise<SidecarSlashCommandResult> {
    const copy = uiText(this.settings.language)
    const skills = new SkillService(this.root)
    if (command.action === "list") {
      const available = await skills.available()
      const lines = available.map((skill) => `${skill.id}\n  name: ${skill.name} - ${skill.description}`)
      return { handled: true, title: copy.skillsTitle, text: available.length === 0 ? copy.noSkillsFound : lines.join("\n") }
    }
    if (command.action === "clear") {
      this.settings = normalizeSessionSettings({ ...this.settings, selectedSkills: [], pendingSkillLoads: [] }, this.settings.provider)
      return { handled: true, title: copy.skillsTitle, text: copy.skillsCleared, settings: this.settings }
    }
    if (command.action === "use") {
      const skill = await skills.load(command.name)
      if (!skill) return { handled: true, title: copy.skillsTitle, text: copy.skillNotFound(command.name) }
      this.settings = normalizeSessionSettings({
        ...this.settings,
        selectedSkills: [...new Set([...(this.settings.selectedSkills ?? []), skill.id])],
        pendingSkillLoads: [...new Set([...(this.settings.pendingSkillLoads ?? []), skill.id])],
      }, this.settings.provider)
      return { handled: true, title: copy.skillsTitle, text: copy.skillActivated(skill.id), settings: this.settings }
    }
    const removed = (this.settings.selectedSkills ?? []).filter((id) => id === command.name || id.endsWith(`/${command.name}`) || id.endsWith(`:${command.name}`))
    if (removed.length === 0) return { handled: true, title: copy.skillsTitle, text: copy.noActiveSkillFound(command.name) }
    this.settings = normalizeSessionSettings({
      ...this.settings,
      selectedSkills: (this.settings.selectedSkills ?? []).filter((id) => !removed.includes(id)),
      pendingSkillLoads: (this.settings.pendingSkillLoads ?? []).filter((id) => !removed.includes(id)),
    }, this.settings.provider)
    return { handled: true, title: copy.skillsTitle, text: copy.skillRemoved(removed.join(", ")), settings: this.settings }
  }

  private settingsText(pendingImages: number, pendingFiles: number) {
    return uiText(this.settings.language).settingsText({
      provider: this.settings.provider,
      model: this.settings.model,
      thinking: this.settings.thinking,
      effort: this.settings.effort,
      language: languageDisplay(this.settings.language),
      skills: this.settings.selectedSkills.join(", ") || "(none)",
      pendingSkillLoads: this.settings.pendingSkillLoads.join(", ") || "(none)",
      pendingImages,
      pendingFiles,
      maxTokens: this.settings.maxTokens,
      maxSteps: this.settings.maxSteps,
    })
  }

  private async persistCurrentSettings() {
    const store = this.store()
    const loaded = await store.load(this.session)
    const context = await this.rawSessionContext(this.session)
    await store.save(this.session, context, this.settings, normalizeSessionTokenUsage(loaded?.tokenUsage))
  }

  private async executePrompt(runId: string, session: string, text: string, mode: RunPromptMode, permissionMode: RunPromptPermissionMode, imageInputs: string[], fileInputs: string[], abort: AbortController) {
    const store = this.store()
    const context = await store.context(session)
    const settings = await this.sessionSettings(store, session)
    const logger = createLogger({ root: this.root, session })
    emitLog(logger, { type: "data", name: "sidecar.run", detail: { mode, root: this.root, session, loadedEnvVars: this.loadedEnvVars } })
    let usage = normalizeSessionTokenUsage((await store.load(session))?.tokenUsage)
    const promptText = await promptWithAttachedFiles(this.root, text, fileInputs)
    if (mode === "goal") {
      return await this.executeGoalPrompt(runId, session, context, settings, usage, logger, promptText, abort)
    }
    const images = await this.imageParts(imageInputs)
    const suppressPlanRunDone = mode === "plan"
    const result = await this.runOnce(runId, session, context, settings, usage, logger, promptText, mode, abort, { images, permissionMode, emitRunDone: suppressPlanRunDone ? false : undefined })
    usage = result.usage
    if (result.status === "completed" && hasProposedPlanText(result.text)) {
      await savePlan(this.root, session, result.text)
      const planId = currentPlanID(context)
      const planState = planId ? await loadStructuredPlanState(this.root, session, planId) : undefined
      if (planState?.plan.lowRisk) {
        emitLog(logger, { type: "state", name: "plan.approval", detail: { planId, approval_source: "low_risk_auto", lowRisk: true } })
        return await this.runOnce(runId, session, context, settings, usage, logger, "Proceed with the approved plan.", "build", abort, { permissionMode })
      }
      const reply = await this.awaitPlanReply(runId, result.text)
      if (reply.action === "approve") {
        return await this.runOnce(runId, session, context, settings, usage, logger, "Proceed with the approved plan.", "build", abort, { permissionMode })
      }
      if (reply.action === "edit" || reply.action === "new_prompt") {
        const replyText = reply.text
        if (!replyText) throw new SidecarProtocolError("invalid_params", "Plan reply text is required.")
        return await this.runOnce(runId, session, context, settings, usage, logger, replyText, "plan", abort, { permissionMode })
      }
      this.emit({ type: "run_done", status: "cancelled" }, runId)
      return { status: "cancelled", text: result.text, usage }
    }
    if (suppressPlanRunDone) this.emit({ type: "run_done", status: result.status }, runId)
    return result
  }

  private async executeGoalPrompt(runId: string, session: string, context: ContextManagerLike, settings: SessionSettings, usage: SessionTokenUsage, logger: Logger | undefined, text: string, abort: AbortController) {
    const controller = new GoalFlowController({
      root: this.root,
      session,
      context,
      logger,
      onEvent: (event) => this.emit(event, runId),
    })
    const queued = await controller.start(text)
    return await this.executeGoalQueue(runId, session, context, settings, usage, logger, queued, abort, controller)
  }

  private async executeGoalQueue(runId: string, session: string, context: ContextManagerLike, settings: SessionSettings, usage: SessionTokenUsage, logger: Logger | undefined, initial: QueuedControllerPrompt, abort: AbortController, controller = new GoalFlowController({
    root: this.root,
    session,
    context,
    logger,
    onEvent: (event) => this.emit(event, runId),
  })) {
    let currentUsage = usage
    let queued: QueuedControllerPrompt | undefined = initial
    let final = { status: "completed", text: "" }
    while (queued) {
      const messageCountBeforeRun = context.state.messages.length
      const result = await this.runOnce(runId, session, context, settings, currentUsage, logger, queued.text, queued.mode, abort, { permissionRuleMode: "goal", emitRunDone: false })
      currentUsage = result.usage
      const next = await controller.handleRunResult({ result, messageCountBeforeRun })
      await this.store().save(session, context, settings, currentUsage)
      if (next.type === "next") {
        queued = next.prompt
      } else {
        queued = undefined
        final = { status: next.status, text: next.text }
      }
    }
    this.emit({ type: "run_done", status: final.status }, runId)
    return { ...final, usage: currentUsage }
  }

  private async runOnce(runId: string, session: string, context: ContextManagerLike, settings: SessionSettings, usage: SessionTokenUsage, logger: Logger | undefined, text: string, mode: AgentMode, abort: AbortController, options: { permissionMode?: RunPromptPermissionMode; permissionRuleMode?: "build" | "plan" | "goal"; emitRunDone?: boolean; images?: ImagePart[] } = {}) {
    const store = this.store()
    let mainMetrics: ProviderRunMetrics | undefined
    let subagentUsage = normalizeSessionTokenUsage(undefined)
    const onEvent = (event: RunUiEvent) => {
      if (event.type === "provider_metrics" && event.metrics.source !== "subagent") mainMetrics = event.metrics
      if (event.type === "subagent" && event.status === "completed" && event.metrics) subagentUsage = addSubagentMetricsToUsage(subagentUsage, event.metrics)
      if (event.type === "run_done" && options.emitRunDone === false) return
      this.emit(event, runId)
    }
    const runner = createRunner({
      root: this.root,
      provider: settings.provider,
      mode,
      logger,
      context,
      permission: this.permission(options.permissionRuleMode ?? mode, runId, options.permissionMode ?? "ask"),
      settings,
      onEvent,
      onBackgroundContextUpdate: () => store.save(session, context, settings, usage),
      sessionId: session,
      forcePlanning: mode === "plan",
    })
    const result = await runner.run(text, mode, { images: options.images ?? [], signal: abort.signal })
    usage = addRunUsage(usage, mainMetrics, subagentUsage)
    await store.save(session, runner.context, settings, usage)
    return { status: result.status, failureReason: result.failureReason, text: result.text, usedTools: result.usedTools, usage }
  }

  private permission(mode: AgentMode | "goal", runId: string, permissionMode: RunPromptPermissionMode) {
    if (mode === "goal") {
      return new PermissionService(defaultPermissionRules("goal"), async () => "reject" as const, defaultPermissionAutoReviewer)
    }
    if (permissionMode === "auto-review") {
      return new PermissionService(defaultPermissionRules(mode), async () => "reject" as const, defaultPermissionAutoReviewer)
    }
    return new PermissionService(defaultPermissionRules(mode), async (request) => {
      this.emit({ type: "permission_request", request }, runId)
      return await new Promise<PermissionReply>((resolve) => this.pendingPermissions.set(request.id, { resolve }))
    }, defaultPermissionAutoReviewer)
  }

  private async imageParts(inputs: string[]) {
    return await Promise.all(inputs.map((input) => imagePartFromInput(input, this.root)))
  }

  private async awaitPlanReply(runId: string, markdown: string) {
    this.emit({ type: "plan_approval_request", markdown }, runId)
    return await new Promise<{ action: "approve" | "reject" | "edit" | "new_prompt"; text?: string }>((resolve) => {
      if (!this.activeRun || this.activeRun.id !== runId) throw new PermissionRejectedError("Run is no longer active.")
      this.activeRun.pendingPlan = { resolve }
    })
  }

  private async sessionSettings(store: SessionStore, session: string) {
    const loaded = await store.load(session)
    if (!loaded) return normalizeSessionSettings(this.settings, this.settings.provider)
    this.settings = normalizeSessionSettings(loaded.settings, this.settings.provider)
    return this.settings
  }

  private store() {
    return new SessionStore(this.root)
  }

  private async rawSessionContext(session: string) {
    const context = new ContextManager()
    const loaded = await this.store().load(session)
    if (!loaded) return context
    for (const message of loaded.messages) context.add(message)
    context.state.summary = loaded.summary
    context.setLedger(loaded.ledger)
    return context
  }

  private emit(event: SidecarEvent, runId?: string) {
    this.writeEvent({ type: "event", ...(runId ? { runId } : {}), event })
  }
}

function addRunUsage(usage: SessionTokenUsage, main: ProviderRunMetrics | undefined, subagent: SessionTokenUsage): SessionTokenUsage {
  const next = { ...usage }
  addUsageValue(next, "inputTokens", main?.inputTokens ?? 0)
  addUsageValue(next, "outputTokens", main?.outputTokens ?? 0)
  addUsageValue(next, "calls", main?.calls ?? 0)
  addUsageValue(next, "subagentInputTokens", subagent.subagentInputTokens)
  addUsageValue(next, "subagentOutputTokens", subagent.subagentOutputTokens)
  addUsageValue(next, "subagentCalls", subagent.subagentCalls)
  addUsageValue(next, "subagentCacheHitTokens", subagent.subagentCacheHitTokens)
  addUsageValue(next, "subagentCacheMissTokens", subagent.subagentCacheMissTokens)
  return next
}

function addSubagentMetricsToUsage(usage: SessionTokenUsage, metrics: ProviderRunMetrics): SessionTokenUsage {
  const next = { ...usage }
  addUsageValue(next, "subagentInputTokens", metrics.inputTokens)
  addUsageValue(next, "subagentOutputTokens", metrics.outputTokens)
  addUsageValue(next, "subagentCalls", metrics.calls)
  addUsageValue(next, "subagentCacheHitTokens", metrics.cacheHitTokens)
  addUsageValue(next, "subagentCacheMissTokens", metrics.cacheMissTokens)
  return next
}

function addUsageValue(usage: SessionTokenUsage, key: keyof SessionTokenUsage, value: number) {
  usage[key] += value
}

function nextRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function planStatusText(planId: string, plan: Awaited<ReturnType<typeof loadStructuredPlanState>>, status?: string, currentStepId?: string, blocker?: string) {
  return [
    `Plan: ${plan?.plan.title ?? planId}`,
    `Status: ${status ?? "unknown"}`,
    `Current step: ${currentStepId ?? "none"}`,
    `Steps: ${plan ? Object.values(plan.checkpoint.stepStatuses).filter((value) => value === "completed").length : 0}/${plan?.plan.steps.length ?? 0}`,
    `Blocker: ${blocker ?? "none"}`,
  ].join("\n")
}

async function sessionsText(store: SessionStore, currentSession: string | undefined, language: SessionSettings["language"]) {
  const copy = uiText(language)
  const sessions = await store.list()
  if (sessions.length === 0) return copy.noSavedSessions
  return [
    copy.savedSessions,
    ...sessions.map((session, index) => copy.sessionSummary(index + 1, session.id, session.id === currentSession, session.messageCount)),
  ].join("\n")
}
