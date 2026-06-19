import path from "node:path"
import { createRunner, hasProposedPlanText } from "../agent"
import type { ContextManagerLike } from "../context"
import { createLogger, emitLog, type Logger } from "../logger"
import type { AgentMode } from "../message"
import { defaultPermissionAutoReviewer, defaultPermissionRules, PermissionRejectedError, PermissionService, type PermissionReply, type PermissionRequest } from "../permission"
import { savePlan } from "../plans"
import { normalizeSessionTokenUsage, SessionStore, type SessionTokenUsage } from "../session"
import { defaultSessionSettings, normalizeSessionSettings, type SessionSettings } from "../settings"
import { loadEnvFile } from "../cli/startup"
import type { ProviderRunMetrics, RunUiEvent } from "../ui/timeline"
import { SidecarProtocolError } from "./jsonl"
import { parseInitializeParams, parseReplyPermissionParams, parseReplyPlanParams, parseRunPromptParams, parseSessionParam, record } from "./params"
import { sidecarProtocolVersion, type SidecarEvent, type SidecarEventEnvelope, type SidecarRequest } from "./types"

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
  private settings: SessionSettings = defaultSessionSettings("fake")
  private loadedEnvVars = 0
  private activeRun: ActiveRun | undefined
  private readonly pendingPermissions = new Map<string, PendingPermission>()

  constructor(private readonly writeEvent: Writer) {}

  async handle(request: SidecarRequest) {
    switch (request.method) {
      case "initialize": return await this.initialize(request.params)
      case "listSessions": return { sessions: await this.store().list(), currentSession: this.session }
      case "loadSession": return await this.loadSession(request.params)
      case "deleteSession": return await this.store().delete(parseSessionParam(request.params, this.session))
      case "getSettings": return { root: this.root, session: this.session, settings: this.settings }
      case "updateSettings": return this.updateSettings(request.params)
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
    return { session: loaded, messages: loaded?.messages ?? [] }
  }

  private updateSettings(params: unknown) {
    const input = record(params)
    const provider = typeof input.provider === "string" && input.provider ? input.provider : this.settings.provider
    this.settings = normalizeSessionSettings({ ...this.settings, ...input, provider }, provider)
    return { settings: this.settings }
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
      const result = await this.executePrompt(runId, session, input.text, input.mode ?? "build", abort)
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

  private async executePrompt(runId: string, session: string, text: string, mode: AgentMode, abort: AbortController) {
    const store = this.store()
    const context = await store.context(session)
    const settings = await this.sessionSettings(store, session)
    const logger = createLogger({ root: this.root, session })
    emitLog(logger, { type: "data", name: "sidecar.run", detail: { mode, root: this.root, session, loadedEnvVars: this.loadedEnvVars } })
    let usage = normalizeSessionTokenUsage((await store.load(session))?.tokenUsage)
    const result = await this.runOnce(runId, session, context, settings, usage, logger, text, mode, abort)
    usage = result.usage
    if (result.status === "completed" && hasProposedPlanText(result.text)) {
      await savePlan(this.root, session, result.text)
      const reply = await this.awaitPlanReply(runId, result.text)
      if (reply.action === "approve") {
        return await this.runOnce(runId, session, context, settings, usage, logger, "Proceed with the approved plan.", "build", abort)
      }
      if (reply.action === "edit" || reply.action === "new_prompt") {
        return await this.runOnce(runId, session, context, settings, usage, logger, reply.text ?? text, "plan", abort)
      }
      return { status: "cancelled", text: result.text, usage }
    }
    return result
  }

  private async runOnce(runId: string, session: string, context: ContextManagerLike, settings: SessionSettings, usage: SessionTokenUsage, logger: Logger | undefined, text: string, mode: AgentMode, abort: AbortController) {
    const store = this.store()
    let mainMetrics: ProviderRunMetrics | undefined
    let subagentUsage = normalizeSessionTokenUsage(undefined)
    const onEvent = (event: RunUiEvent) => {
      if (event.type === "provider_metrics" && event.metrics.source !== "subagent") mainMetrics = event.metrics
      if (event.type === "subagent" && event.status === "completed" && event.metrics) subagentUsage = addSubagentMetricsToUsage(subagentUsage, event.metrics)
      this.emit(event, runId)
    }
    const runner = createRunner({
      root: this.root,
      provider: settings.provider,
      mode,
      logger,
      context,
      permission: this.permission(mode, runId),
      settings,
      onEvent,
      onBackgroundContextUpdate: () => store.save(session, context, settings, usage),
      sessionId: session,
      forcePlanning: mode === "plan",
    })
    const result = await runner.run(text, mode, { signal: abort.signal })
    usage = addRunUsage(usage, mainMetrics, subagentUsage)
    await store.save(session, runner.context, settings, usage)
    return { status: result.status, failureReason: result.failureReason, text: result.text, usedTools: result.usedTools, usage }
  }

  private permission(mode: AgentMode, runId: string) {
    return new PermissionService(defaultPermissionRules(mode), async (request) => {
      this.emit({ type: "permission_request", request }, runId)
      return await new Promise<PermissionReply>((resolve) => this.pendingPermissions.set(request.id, { resolve }))
    }, defaultPermissionAutoReviewer)
  }

  private async awaitPlanReply(runId: string, markdown: string) {
    this.emit({ type: "plan_approval_request", markdown }, runId)
    return await new Promise<{ action: "approve" | "reject" | "edit" | "new_prompt"; text?: string }>((resolve) => {
      if (!this.activeRun || this.activeRun.id !== runId) throw new PermissionRejectedError("Run is no longer active.")
      this.activeRun.pendingPlan = { resolve }
    })
  }

  private async sessionSettings(store: SessionStore, session: string) {
    const stored = await store.settings(session, this.settings.provider)
    this.settings = normalizeSessionSettings({ ...stored, ...this.settings }, this.settings.provider)
    return this.settings
  }

  private store() {
    return new SessionStore(this.root)
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
