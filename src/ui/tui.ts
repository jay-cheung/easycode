import type { PermissionRequest } from "../permission"
import type { SessionTokenUsage } from "../session"
import { uiText, type UiLanguage } from "../i18n"
import { TimelineRenderer, type RunUiEvent, type ProviderRunMetrics } from "./timeline"
import { ensureTrailingNewline, formatDuration } from "./tui-ansi"
import { buildConfiguredCard, buildFailureSummaryCard, buildPanelCard, buildSessionStartedCard, buildSuccessSummaryCard, buildWelcomeDashboardCard } from "./tui-cards"
import { generateStatusPanelLines, spinnerFrames } from "./tui-status-panel"
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
  private rendered = false
  private lastStatus = "ready"
  
  // TUI State
  private running = false
  private streaming = false
  private pausedForPrompt = false
  private statusText = "ready"
  private elapsedStart = 0
  private elapsedMs = 0
  private spinnerFrame = 0
  private spinnerTimer: NodeJS.Timeout | undefined = undefined
  private panelDrawnLines = 0
  private panelDirty = false
  private metrics: ProviderRunMetrics | undefined = undefined
  private queuedPrompt: string | undefined = undefined
  private sessionTokenUsage: SessionTokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 }

  getPausedForPrompt() {
    return this.pausedForPrompt
  }

  resumeAfterPrompt() {
    this.pausedForPrompt = false
    if (this.running && !this.spinnerTimer) {
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

  configure(context: Partial<TuiContext>, status = this.lastStatus) {
    this.context = { ...this.context, ...context }
    this.timeline.setLanguage(this.getLanguage())
    this.lastStatus = status
    
    // If not running, display a beautiful compact settings card when settings change
    if (!this.running && this.rendered) {
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
      this.running = true
      this.streaming = false
      this.pausedForPrompt = false
      this.queuedPrompt = undefined
      this.metrics = undefined
      this.context = { ...this.context, mode: event.mode, provider: event.provider, model: event.model }
      this.statusText = copy.statusInitializing
      this.elapsedStart = Date.now()
      this.elapsedMs = 0
      this.startSpinnerTimer()
    } else if (event.type === "reasoning_delta" || event.type === "text_delta") {
      this.pausedForPrompt = false // prompt is completed
      if (!this.streaming) {
        this.streaming = true
        this.eraseStatusPanel() // Cleanly erase panel when streaming starts to prevent any overlap
      }
      this.statusText = event.type === "reasoning_delta" ? copy.statusThinking : copy.statusAnswering
    } else {
      this.streaming = false
      
      // If we receive a state-changing event indicating prompt resolution
      if (["tool_call", "tool_result", "run_done", "failure"].includes(event.type)) {
        this.pausedForPrompt = false
      }
      
      // Restart spinner timer only if we are running and NOT paused for a prompt
      if (this.running && !this.spinnerTimer && !this.pausedForPrompt) {
        this.startSpinnerTimer()
      }
    }

    if (event.type === "provider_progress") {
      this.statusText = copy.statusWaitingProvider(event.provider)
    } else if (event.type === "tool_call") {
      this.statusText = copy.statusExecutingTool(event.call.name)
    } else if (event.type === "tool_progress") {
      this.statusText = copy.statusRunningTool(event.toolName, formatDuration(event.elapsedMs))
    } else if (event.type === "tool_result") {
      this.statusText = copy.statusToolCompleted(event.toolName)
    } else if (event.type === "context_compaction") {
      if (event.status === "started") {
        this.statusText = copy.statusCompacting
      } else {
        this.statusText = copy.statusCompactionDone(event.status)
      }
    } else if (event.type === "repo_map") {
      this.statusText = copy.statusRepoMap(event.status)
    } else if (event.type === "provider_metrics") {
      this.metrics = event.metrics
      if (!event.interim) {
        this.statusText = copy.statusProviderMetrics
      }
    } else if (event.type === "failure") {
      this.running = false
      this.streaming = false
      this.pausedForPrompt = false
      this.stopSpinnerTimer()
      this.eraseStatusPanel()
      this.renderFailureSummary(event.text)
    } else if (event.type === "run_done") {
      this.running = false
      this.streaming = false
      this.pausedForPrompt = false
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
    if (this.running) {
      this.running = false
      this.streaming = false
      this.pausedForPrompt = false
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
    this.pausedForPrompt = true
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
    this.pausedForPrompt = true
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
    this.queuedPrompt = text
    this.writeText(`TUI: ${copy.queuedNextInput(text)}\n`)
  }

  cancelling() {
    const copy = uiText(this.getLanguage())
    this.status(copy.statusCancelling)
    this.statusText = copy.cancellingRun
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
    this.lastStatus = status
    this.writeText(`[status] ${status}\n`)
  }

  // Helper to write text that handles dynamic panel erasure/redraw
  private writeText(text: string) {
    if (this.running) {
      if (this.streaming || this.pausedForPrompt) {
        this.output.write(text)
      } else {
        this.eraseStatusPanel()
        this.output.write(text)
        this.drawStatusPanel()
      }
    } else {
      this.output.write(text)
    }
  }

  // TUI Core Redrawing and Erasing Logics
  writeFromTimeline(text: string) {
    if (this.running) {
      if (this.streaming || this.pausedForPrompt) {
        // Direct print during active text delta streaming or manual prompts to prevent layout overlaps
        this.output.write(text)
      } else {
        this.eraseStatusPanel()
        this.output.write(text)
        
        // If the printed text doesn't end with a newline, we can set panel as dirty
        if (!text.endsWith("\n")) {
          this.panelDirty = true
        } else {
          this.drawStatusPanel()
        }
      }
    } else {
      this.output.write(text)
    }
  }

  private startSpinnerTimer() {
    this.stopSpinnerTimer()
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % spinnerFrames().length
      this.elapsedMs = Date.now() - this.elapsedStart
      if (this.running && !this.streaming && !this.pausedForPrompt) {
        this.drawStatusPanel()
        this.panelDirty = false
      }
    }, 80)
  }

  private stopSpinnerTimer() {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
  }

  private eraseStatusPanel() {
    if (!this.panelDrawnLines) return
    for (let i = 0; i < this.panelDrawnLines; i++) {
      this.output.write("\x1b[1A\x1b[2K\r")
    }
    this.panelDrawnLines = 0
  }

  private drawStatusPanel() {
    if (!this.running || this.streaming || this.pausedForPrompt) return
    
    // Safety check to ensure we clean up the previous lines
    this.eraseStatusPanel()
    
    const lines = generateStatusPanelLines({
      context: this.context,
      language: this.getLanguage(),
      columns: this.getColumns(),
      spinnerFrame: this.spinnerFrame,
      elapsedMs: this.elapsedMs,
      statusText: this.statusText,
      queuedPrompt: this.queuedPrompt,
      metrics: this.metrics,
    })
    for (const line of lines) {
      this.output.write(line + "\n")
    }
    this.panelDrawnLines = lines.length
  }

  private renderWelcomeDashboard() {
    this.output.write(`\n${buildWelcomeDashboardCard(this.context, this.lastStatus, this.getColumns())}\n`)
    this.rendered = true
  }

  private renderSuccessSummary() {
    this.writeText(`\n${buildSuccessSummaryCard(this.getLanguage(), this.elapsedMs, this.metrics, this.sessionTokenUsage, this.getColumns())}\n`)
  }

  private renderFailureSummary(reason: string) {
    this.writeText(`\n${buildFailureSummaryCard(this.getLanguage(), this.elapsedMs, this.metrics, this.sessionTokenUsage, reason, this.getColumns())}\n`)
  }
}
