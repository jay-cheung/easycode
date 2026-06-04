import type { PermissionRequest } from "../permission"
import type { SessionTokenUsage } from "../session"
import { uiText, type UiLanguage } from "../i18n"
import { TimelineRenderer, type RunUiEvent } from "./timeline"
import { ensureTrailingNewline, formatDuration } from "./tui-ansi"
import { buildConfiguredCard, buildFailureSummaryCard, buildPanelCard, buildSessionStartedCard, buildSuccessSummaryCard, buildWelcomeDashboardCard } from "./tui-cards"
import { TuiState } from "./tui-state"
import { spinnerFrames } from "./tui-status-panel"
import { drawStatusPanel, eraseStatusPanel, renderFailureSummary, renderSuccessSummary, renderWelcomeDashboard, writeTextWithPanel, writeTimelineText } from "./tui-render-loop"
import type { TuiContext, Writable } from "./tui-types"

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
  private sessionTokenUsage: SessionTokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 }
  private providerCallCount = 0
  private currentProviderPhaseKey = ""

  getPausedForPrompt() {
    return this.state.pausedForPrompt
  }

  resumeAfterPrompt() {
    this.state.resolvePrompt()
    if (this.state.running && !this.spinnerTimer) {
      this.startSpinnerTimer()
    }
  }

  setSessionTokenUsage(usage: SessionTokenUsage) {
    this.sessionTokenUsage = { ...usage }
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
    if (event.type === "run_start") {
      this.state.beginRun(copy.statusInitializing)
      this.context = { ...this.context, mode: event.mode, provider: event.provider, model: event.model }
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

    if (event.type === "provider_progress") {
      if (event.elapsedMs === 0 || !this.currentProviderPhaseKey) {
        this.providerCallCount++
        this.currentProviderPhaseKey = `provider:${event.provider}:${event.model ?? "unknown"}:${this.providerCallCount}`
      }
      this.state.setStatus(copy.statusWaitingProvider(event.provider), this.currentProviderPhaseKey)
    } else if (event.type === "tool_call") {
      this.state.setStatus(copy.statusExecutingTool(event.call.name), `tool:${event.call.id}:call`)
    } else if (event.type === "tool_progress") {
      this.state.setStatus(copy.statusRunningTool(event.toolName, formatDuration(event.elapsedMs)), `tool:${event.callID}:progress`)
    } else if (event.type === "tool_result") {
      this.state.setStatus(copy.statusToolCompleted(event.toolName), `tool:${event.callID}:result`)
    } else if (event.type === "context_compaction") {
      if (event.status === "started") {
        this.state.setStatus(copy.statusCompacting, "context_compaction:started")
      } else {
        this.state.setStatus(copy.statusCompactionDone(event.status), `context_compaction:${event.status}`)
      }
    } else if (event.type === "repo_map") {
      this.state.setStatus(copy.statusRepoMap(event.status), `repo_map:${event.status}`)
    } else if (event.type === "provider_metrics") {
      this.state.metrics = event.metrics
      if (!event.interim) {
        this.state.setStatus(copy.statusProviderMetrics, "provider_metrics:final")
      }
    } else if (event.type === "failure") {
      this.state.finishRun()
      this.stopSpinnerTimer()
      this.eraseStatusPanel()
      this.renderFailureSummary(event.text)
    } else if (event.type === "run_done") {
      this.state.finishRun()
      this.stopSpinnerTimer()
      this.eraseStatusPanel()
      this.renderSuccessSummary()
    }
    
    if (event.type === "run_start") {
      this.configure({ mode: event.mode, provider: event.provider, model: event.model }, copy.statusRunning)
    } else if (event.type === "failure") {
      this.status(copy.statusFailed)
    } else if (event.type === "run_done") {
      this.status(event.status)
    }

    // Forward to timeline
    this.timeline.event(event)
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
    renderSuccessSummary(this.output, this.getLanguage(), this.state.runElapsedMs, this.state.metrics, this.sessionTokenUsage, this.getColumns())
  }

  private renderFailureSummary(reason: string) {
    renderFailureSummary(this.output, this.getLanguage(), this.state.runElapsedMs, this.state.metrics, this.sessionTokenUsage, reason, this.getColumns())
  }
}
