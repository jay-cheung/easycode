import type { PermissionRequest } from "../../permission"
import { normalizeSessionTokenUsage, type SessionTokenUsage } from "../../session"
import { uiText, type UiLanguage } from "../../i18n"
import { TimelineRenderer, type RunUiEvent } from "../timeline"
import { ensureTrailingNewline, formatDuration } from "./tui-ansi"
import { buildConfiguredCard, buildFailureSummaryCard, buildPanelCard, buildSessionStartedCard, buildSubagentUsageCard, buildSuccessSummaryCard, buildWelcomeDashboardCard } from "./tui-cards"
import { TuiState } from "./tui-state"
import { spinnerFrames } from "./tui-status-panel"
import { drawStatusPanel, eraseStatusPanel, renderFailureSummary, renderSuccessSummary, renderWelcomeDashboard, writeTextWithPanel, writeTimelineText } from "./tui-render-loop"
import type { TuiContext, TuiGoalContext, Writable } from "./tui-types"
import { loadStructuredPlanState } from "../../plans"

class TuiWritable implements Writable {
  constructor(private readonly renderer: TuiRenderer) {}

  write(text: string) {
    if (this.renderer.getPausedForPrompt()) {
      return
    }
    this.renderer.writeFromTimeline(text)
  }

  get isTTY() {
    return this.renderer.getIsTTY()
  }

  get columns() {
    return this.renderer.getColumns()
  }
}

export class TuiRenderer {
  private readonly timeline: TimelineRenderer
  private context: TuiContext
  private readonly state = new TuiState()
  private spinnerTimer: NodeJS.Timeout | undefined = undefined
  private lastPanelSnapshot = ""
  private sessionTokenUsage: SessionTokenUsage = normalizeSessionTokenUsage(undefined)
  private pendingFailureText: string | undefined = undefined
  private providerCallCount = 0
  private currentProviderPhaseKey = ""
  private isRefreshingStats = false
  private lastGitRefreshedTime = 0

  getPausedForPrompt() {
    return this.state.pausedForPrompt
  }

  resumeAfterPrompt() {
    this.state.resolvePrompt()
    if (this.state.running && !this.spinnerTimer) {
      this.startSpinnerTimer()
    }
  }

  pauseForInputPrompt() {
    this.state.pauseForPrompt()
    this.stopSpinnerTimer()
    this.eraseStatusPanel()
  }

  setSessionTokenUsage(usage: SessionTokenUsage) {
    this.sessionTokenUsage = normalizeSessionTokenUsage(usage)
  }

  constructor(
    private readonly output: Writable = process.stdout,
    context: TuiContext,
  ) {
    this.timeline = new TimelineRenderer(new TuiWritable(this), context.language ?? "en")
    this.context = context
    
    // Draw welcome screen only once at the beginning
    this.renderWelcomeDashboard()
  }

  getIsTTY() {
    return this.output.isTTY === true
  }

  getColumns() {
    return this.output.columns ?? 80
  }

  getLanguage() {
    return this.context.language ?? "en"
  }

  setLanguage(language: UiLanguage) {
    this.configure({ language })
  }

  setGoal(goal: TuiGoalContext | undefined) {
    this.context = { ...this.context, goal }
    this.refreshActivePlanAndGitStats()
    if (this.state.shouldRenderPanel()) {
      this.lastPanelSnapshot = ""
      this.drawStatusPanel()
    }
  }

  configure(context: Partial<TuiContext>, status = this.state.lastStatus) {
    this.context = { ...this.context, ...context }
    this.timeline.setLanguage(this.getLanguage())
    this.state.lastStatus = status
    
    // If not running, display a beautiful compact settings card when settings change
    if (!this.state.running && this.state.rendered) {
      this.writeText(`\n${buildConfiguredCard(this.context, status, this.getColumns())}\n`)
    }
  }

  startSession(session: string) {
    this.configure({ session }, uiText(this.getLanguage()).statusSessionSelected)
    this.writeText(`\n${buildSessionStartedCard(this.getLanguage(), session, this.getColumns())}\n`)
  }

  event(event: RunUiEvent) {
    const copy = uiText(this.getLanguage())
    let renderedLateSubagentSummary = false
    if (event.type === "run_start") {
      this.state.beginRun(copy.statusInitializing)
      this.context = { ...this.context, mode: event.mode, provider: event.provider, model: event.model }
      this.pendingFailureText = undefined
      this.providerCallCount = 0
      this.currentProviderPhaseKey = ""
      this.startSpinnerTimer()
    } else if (event.type === "reasoning_delta" || event.type === "text_delta") {
      this.state.resolvePrompt()
      if (!this.state.streaming) {
        this.state.beginStreaming(event.type === "reasoning_delta" ? copy.statusThinking : copy.statusAnswering)
        this.eraseStatusPanel() // Cleanly erase panel when streaming starts to prevent any overlap
      } else {
        this.state.statusText = event.type === "reasoning_delta" ? copy.statusThinking : copy.statusAnswering
      }
    } else {
      this.state.stopStreaming()
      
      // If we receive a state-changing event indicating prompt resolution
      if (["tool_call", "tool_result", "run_done", "failure"].includes(event.type)) {
        this.state.resolvePrompt()
      }
      
      // Restart spinner timer only if we are running and NOT paused for a prompt
      if (this.state.running && !this.spinnerTimer && !this.state.pausedForPrompt) {
        this.startSpinnerTimer()
      }
    }

    if (event.type === "goal") {
      this.setGoal(event.phase === "cleared" ? undefined : event.goal)
    } else if (event.type === "provider_progress") {
      if (event.elapsedMs === 0 || !this.currentProviderPhaseKey) {
        this.providerCallCount++
        this.currentProviderPhaseKey = `provider:${event.provider}:${event.model ?? "unknown"}:${this.providerCallCount}`
      }
      let statusText = copy.statusWaitingProvider(event.provider)
      if (event.phase === "thinking") {
        statusText = copy.statusThinking
      } else if (event.phase === "answering") {
        statusText = copy.statusAnswering
      }
      this.state.setStatus(statusText, this.currentProviderPhaseKey)
    } else if (event.type === "provider_retry") {
      this.state.providerRetryCount += 1
    } else if (event.type === "tool_call") {
      this.state.setStatus(copy.statusExecutingTool(event.call.name), `tool:${event.call.id}:call`)
    } else if (event.type === "tool_progress") {
      this.state.setStatus(copy.statusRunningTool(event.toolName, formatDuration(event.elapsedMs)), `tool:${event.callID}:progress`)
    } else if (event.type === "tool_result") {
      this.state.setStatus(copy.statusToolCompleted(event.toolName), `tool:${event.callID}:result`)
      this.refreshActivePlanAndGitStats()
    } else if (event.type === "repo_map") {
      this.state.setStatus(copy.statusRepoMap(event.status), `repo_map:${event.status}`)
    } else if (event.type === "provider_metrics") {
      if (event.metrics.source !== "subagent") {
        this.state.metrics = event.metrics
      }
      if (!event.interim) {
        if (event.metrics.source !== "subagent") {
          this.state.setStatus(copy.statusProviderMetrics, "provider_metrics:final")
        }
      }
    } else if (event.type === "subagent" && event.status === "scheduled") {
      const nextRoleCounts = { ...this.state.subagentUsage.roleCounts }
      nextRoleCounts[event.info.role] = (nextRoleCounts[event.info.role] ?? 0) + 1
      this.state.subagentUsage = {
        ...this.state.subagentUsage,
        invocations: this.state.subagentUsage.invocations + 1,
        roleCounts: nextRoleCounts,
      }
    } else if (event.type === "subagent" && event.metrics) {
      this.state.subagentUsage = {
        ...this.state.subagentUsage,
        inputTokens: this.state.subagentUsage.inputTokens + event.metrics.inputTokens,
        outputTokens: this.state.subagentUsage.outputTokens + event.metrics.outputTokens,
        calls: this.state.subagentUsage.calls + event.metrics.calls,
        cacheHitTokens: this.state.subagentUsage.cacheHitTokens + event.metrics.cacheHitTokens,
        cacheMissTokens: this.state.subagentUsage.cacheMissTokens + event.metrics.cacheMissTokens,
      }
      if (event.status === "completed" && !this.state.running) {
        this.renderLateSubagentSummary(event.info.role, event.metrics)
        renderedLateSubagentSummary = true
      }
    } else if (event.type === "run_done") {
      this.state.finishRun()
      this.stopSpinnerTimer()
      this.eraseStatusPanel()
      this.timeline.finish()
      this.state.lastStatus = event.status
      if (event.status === "completed") {
        this.renderSuccessSummary()
      } else {
        this.renderFailureSummary(this.pendingFailureText ?? event.status)
      }
      this.pendingFailureText = undefined
    } else if (event.type === "failure") {
      this.pendingFailureText = event.text
    }
    
    if (event.type === "run_start") {
      this.configure({ mode: event.mode, provider: event.provider, model: event.model }, copy.statusRunning)
    }

    // Forward to timeline (excluding progress and metrics events which are already displayed in the TUI status panel / cards)
    if (
      event.type !== "provider_progress" &&
      event.type !== "provider_retry" &&
      event.type !== "tool_progress" &&
      event.type !== "provider_metrics" &&
      event.type !== "run_done" &&
      !renderedLateSubagentSummary
    ) {
      this.timeline.event(event)
    }
  }

  finish() {
    if (this.state.running) {
      this.state.finishRun()
      this.stopSpinnerTimer()
      this.eraseStatusPanel()
    }
    this.timeline.finish()
  }

  inputPrompt() {
    const prompt = uiText(this.getLanguage()).inputPrompt
    return this.getIsTTY() ? `\x1b[1m\x1b[32m${prompt.trim()}\x1b[0m ` : prompt
  }

  sessionPrompt() {
    const prompt = uiText(this.getLanguage()).sessionPrompt
    return this.getIsTTY() ? `\x1b[1m\x1b[38;5;99m${prompt.trim()}\x1b[0m ` : prompt
  }

  permissionPrompt(request: PermissionRequest, text: string) {
    // Set paused state before invoking status print to prevent immediate redraws
    this.state.pauseForPrompt()
    this.stopSpinnerTimer()
    this.eraseStatusPanel()

    this.status(`permission: ${request.permission}`)
    
    const rawLines = text.split("\n")
    const formattedLines: string[] = []
    for (const rawLine of rawLines) {
      if (rawLine.trim()) {
        formattedLines.push(rawLine)
      }
    }
    
    const card = buildPanelCard(`🛡️  ${uiText(this.getLanguage()).permissionTitle}`, formattedLines.join("\n"), this.getColumns())
    
    return `[Permission]\n${card}\n`
  }

  planApprovalPrompt() {
    this.state.pauseForPrompt()
    this.stopSpinnerTimer()
    this.eraseStatusPanel()

    this.status(uiText(this.getLanguage()).statusPlanApproval)
    
    return uiText(this.getLanguage()).planApprovalPrompt
  }

  runInputHint() {
    const copy = uiText(this.getLanguage())
    this.status(copy.statusInputMonitor)
    this.writeText(`TUI: ${copy.runInputHint}\n`)
  }

  queued(text: string) {
    const copy = uiText(this.getLanguage())
    this.status(copy.statusQueuedInput)
    this.state.queuedPrompt = text
    this.writeText(`TUI: ${copy.queuedNextInput(text)}\n`)
  }

  cancelling() {
    const copy = uiText(this.getLanguage())
    this.status(copy.statusCancelling)
    this.state.setStatus(copy.cancellingRun, "run:cancelling")
    this.writeText(`TUI: ${copy.cancellingRun}\n`)
  }

  slashCommand(command: string) {
    this.status(`/${command}`)
  }

  panel(title: string, text: string) {
    this.status(title.toLowerCase())
    this.writeText(`\n${buildPanelCard(title, text, this.getColumns())}\n`)
  }

  message(text: string) {
    this.writeText(ensureTrailingNewline(text))
  }

  status(status: string) {
    this.state.lastStatus = status
    this.writeText(`[status] ${status}\n`)
  }

  // Helper to write text that handles dynamic panel erasure/redraw
  private writeText(text: string) {
    this.lastPanelSnapshot = writeTextWithPanel({
      output: this.output,
      state: this.state,
      context: this.context,
      language: this.getLanguage(),
      columns: this.getColumns(),
      lastPanelSnapshot: this.lastPanelSnapshot,
    }, text)
  }

  // TUI Core Redrawing and Erasing Logics
  writeFromTimeline(text: string) {
    this.lastPanelSnapshot = writeTimelineText({
      output: this.output,
      state: this.state,
      context: this.context,
      language: this.getLanguage(),
      columns: this.getColumns(),
      lastPanelSnapshot: this.lastPanelSnapshot,
    }, text)
  }

  private startSpinnerTimer() {
    this.stopSpinnerTimer()
    this.spinnerTimer = setInterval(() => {
      this.state.tickSpinner(spinnerFrames().length)
      this.refreshActivePlanAndGitStats()
      if (this.state.shouldRenderPanel()) {
        this.drawStatusPanel()
        this.state.panelDirty = false
      }
    }, 1_000)
  }

  private stopSpinnerTimer() {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
  }

  private eraseStatusPanel() {
    eraseStatusPanel(this.output, this.state)
    this.lastPanelSnapshot = ""
  }

  private drawStatusPanel() {
    this.lastPanelSnapshot = drawStatusPanel({
      output: this.output,
      state: this.state,
      context: this.context,
      language: this.getLanguage(),
      columns: this.getColumns(),
      lastPanelSnapshot: this.lastPanelSnapshot,
    })
  }

  private renderWelcomeDashboard() {
    renderWelcomeDashboard(this.output, this.context, this.state.lastStatus, this.getColumns())
    this.state.rendered = true
  }

  private renderSuccessSummary() {
    renderSuccessSummary(this.output, this.getLanguage(), this.state.runElapsedMs, this.state.metrics, this.state.subagentUsage, this.sessionTokenUsage, this.getColumns())
  }

  private renderFailureSummary(reason: string) {
    renderFailureSummary(this.output, this.getLanguage(), this.state.runElapsedMs, this.state.metrics, this.state.subagentUsage, this.sessionTokenUsage, reason, this.getColumns())
  }

  private renderLateSubagentSummary(role: string, metrics: NonNullable<Extract<RunUiEvent, { type: "subagent" }>["metrics"]>) {
    this.output.write(`\n${buildSubagentUsageCard(this.getLanguage(), role, metrics, this.getColumns())}\n`)
  }

  private async refreshActivePlanAndGitStats() {
    if (this.isRefreshingStats) return
    this.isRefreshingStats = true

    try {
      const now = Date.now()

      // 1. Refresh plan state
      const goal = this.context.goal
      if (goal && goal.activePlanId) {
        const planId = goal.activePlanId
        const sessionId = this.context.session ?? "once"
        const stored = await loadStructuredPlanState(this.context.root, sessionId, planId)
        if (stored && this.context.goal?.activePlanId === planId) {
          this.state.activePlan = stored
        }
      } else {
        this.state.activePlan = undefined
      }

      // 2. Refresh git stats (at most once every 2s)
      if (now - this.lastGitRefreshedTime > 2000) {
        this.lastGitRefreshedTime = now
        const stats = await getGitDiffStats(this.context.root)
        if (this.context.goal) {
          this.state.gitDiffStats = stats
        }
      }

      // Redraw if the panel is currently shown
      if (this.state.shouldRenderPanel()) {
        this.drawStatusPanel()
      }
    } catch {
      // ignore
    } finally {
      this.isRefreshingStats = false
    }
  }
}

async function getGitDiffStats(cwd: string): Promise<{ filesChanged: number; insertions: number; deletions: number } | undefined> {
  try {
    let proc = Bun.spawn(["git", "diff", "HEAD", "--numstat"], { cwd, stdout: "pipe", stderr: "pipe" })
    let stdout = await new Response(proc.stdout).text()
    let exitCode = await proc.exited

    if (exitCode !== 0) {
      // Fallback if HEAD does not exist (e.g. new repo)
      proc = Bun.spawn(["git", "diff", "--numstat"], { cwd, stdout: "pipe", stderr: "pipe" })
      stdout = await new Response(proc.stdout).text()
      await proc.exited
    }

    const lines = stdout.split(/\r?\n/)
    let filesChanged = 0
    let insertions = 0
    let deletions = 0
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3) {
        filesChanged++
        const ins = parseInt(parts[0], 10)
        const del = parseInt(parts[1], 10)
        if (!isNaN(ins)) insertions += ins
        if (!isNaN(del)) deletions += del
      }
    }
    return { filesChanged, insertions, deletions }
  } catch {
    return undefined
  }
}
