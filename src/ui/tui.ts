import type { PermissionRequest } from "../permission"
import type { SessionTokenUsage } from "../session"
import { TimelineRenderer, type RunUiEvent, type ProviderRunMetrics } from "./timeline"

type Writable = {
  write(text: string): unknown
  isTTY?: boolean
  columns?: number
}

export type TuiContext = {
  root: string
  mode: string
  provider: string
  model?: string
  session?: string
  logger?: boolean
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
    this.timeline = new TimelineRenderer(new TuiWritable(this))
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

  configure(context: Partial<TuiContext>, status = this.lastStatus) {
    this.context = { ...this.context, ...context }
    this.lastStatus = status
    
    // If not running, display a beautiful compact settings card when settings change
    if (!this.running && this.rendered) {
      const modelStr = this.context.model ?? "(provider default)"
      const line = `provider: \x1b[35m${this.context.provider}\x1b[0m  ·  model: \x1b[32m${modelStr}\x1b[0m  ·  mode: \x1b[36m${this.context.mode}\x1b[0m  ·  status: \x1b[93m${status}\x1b[0m`
      const card = drawCard("⚙️  TUI Configured", [line], this.getColumns(), {
        color: "\x1b[90m",
        borderStyle: "round"
      })
      this.writeText("\n" + card + "\n")
    }
  }

  startSession(session: string) {
    this.configure({ session }, "session selected")
    const line = `Active Session: \x1b[1m\x1b[38;5;99m${session}\x1b[0m`
    const card = drawCard("📝 Session Started", [line], this.getColumns(), {
      color: "\x1b[38;5;99m",
      borderStyle: "round"
    })
    this.writeText("\n" + card + "\n")
  }

  event(event: RunUiEvent) {
    if (event.type === "run_start") {
      this.running = true
      this.streaming = false
      this.pausedForPrompt = false
      this.queuedPrompt = undefined
      this.metrics = undefined
      this.context = { ...this.context, mode: event.mode, provider: event.provider, model: event.model }
      this.statusText = "Initializing run..."
      this.elapsedStart = Date.now()
      this.elapsedMs = 0
      this.startSpinnerTimer()
    } else if (event.type === "reasoning_delta" || event.type === "text_delta") {
      this.pausedForPrompt = false // prompt is completed
      if (!this.streaming) {
        this.streaming = true
        this.eraseStatusPanel() // Cleanly erase panel when streaming starts to prevent any overlap
      }
      this.statusText = event.type === "reasoning_delta" ? "Model thinking..." : "Model answering..."
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
      this.statusText = `Waiting for ${event.provider}...`
    } else if (event.type === "tool_call") {
      this.statusText = `Executing tool: ${event.call.name}`
    } else if (event.type === "tool_progress") {
      this.statusText = `Running tool: ${event.toolName} (${formatDuration(event.elapsedMs)})`
    } else if (event.type === "tool_result") {
      this.statusText = `Tool completed: ${event.toolName}`
    } else if (event.type === "context_compaction") {
      if (event.status === "started") {
        this.statusText = "Compacting context..."
      } else {
        this.statusText = `Context compaction ${event.status}`
      }
    } else if (event.type === "repo_map") {
      this.statusText = `Prewarming repo map (${event.status})`
    } else if (event.type === "provider_metrics") {
      this.metrics = event.metrics
      this.statusText = "Received provider metrics"
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
      this.configure({ mode: event.mode, provider: event.provider, model: event.model }, "running")
    } else if (event.type === "failure") {
      this.status("failed")
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
    return this.getIsTTY() ? "\x1b[1m\x1b[32measycode>\x1b[0m " : "easycode> "
  }

  sessionPrompt() {
    return this.getIsTTY() ? "\x1b[1m\x1b[38;5;99msession>\x1b[0m " : "session> "
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
    
    const card = drawCard("🛡️  Permission Required", formattedLines, this.getColumns(), {
      color: "\x1b[33m",
      borderStyle: "round"
    })
    
    return `[Permission]\n${card}\n`
  }

  planApprovalPrompt() {
    this.pausedForPrompt = true
    this.stopSpinnerTimer()
    this.eraseStatusPanel()

    this.status("plan approval")
    
    return "[Plan] [A]pprove & execute  [R]eject  [E]dit plan  [N]ew prompt [A]: "
  }

  runInputHint() {
    this.status("input monitor")
    this.writeText("TUI: Type /cancel to stop this run; other input is queued for the next run.\n")
  }

  queued(text: string) {
    this.status("queued input")
    this.queuedPrompt = text
    this.writeText(`TUI: Queued next input: ${text}\n`)
  }

  cancelling() {
    this.status("cancelling")
    this.statusText = "Cancelling current run..."
    this.writeText("TUI: cancelling current run...\n")
  }

  slashCommand(command: string) {
    this.status(`/${command}`)
  }

  panel(title: string, text: string) {
    this.status(title.toLowerCase())
    
    let lines = text.split("\n")
    while (lines.length > 0 && !lines[0].trim()) lines.shift()
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
    
    const borderStyle = title.toLowerCase() === "help" ? "round" : "single"
    const color = title.toLowerCase() === "help" ? "\x1b[34m" : "\x1b[36m"
    
    const card = drawCard(title, lines, this.getColumns(), {
      color: color,
      borderStyle: borderStyle,
      minWidth: 72
    })
    
    this.writeText("\n" + card + "\n")
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
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length
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
    
    const lines = this.generateStatusPanelLines()
    for (const line of lines) {
      this.output.write(line + "\n")
    }
    this.panelDrawnLines = lines.length
  }

  private generateStatusPanelLines(): string[] {
    const width = Math.max(60, Math.min(this.getColumns(), 90))
    const chars = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    
    const lines: string[] = []
    const color = "\x1b[38;5;198m" // premium pink
    const reset = "\x1b[0m"
    
    // Line 1: Top Border
    const title = ` EasyCode Live Monitor `
    const leftH = chars.h.repeat(2)
    const rightH = chars.h.repeat(Math.max(0, width - title.length - 4))
    lines.push(`${color}${chars.tl}${leftH}${title}${rightH}${chars.tr}${reset}`)
    
    // Line 2: Spinner + Mode + Provider + Model + Session ID
    const spinner = SPINNER_FRAMES[this.spinnerFrame]
    const modeBadge = this.context.mode === "build" 
      ? "\x1b[45m\x1b[37m\x1b[1m BUILD \x1b[0m" 
      : "\x1b[44m\x1b[37m\x1b[1m PLAN \x1b[0m"
    const providerStr = `\x1b[1m🤖 ${this.context.provider}\x1b[0m`
    const modelStr = this.context.model ? `\x1b[90m(${this.context.model})\x1b[0m` : ""
    const sessionStr = `\x1b[93msession:${this.context.session ?? "default"}\x1b[0m`
    
    const contentLine1 = `  \x1b[35m${spinner}\x1b[0m  ${modeBadge}  ${providerStr} ${modelStr}  ·  ${sessionStr}`
    const visibleLen1 = displayWidth(contentLine1)
    const paddedLine1 = contentLine1 + " ".repeat(Math.max(0, width - visibleLen1 - 4))
    lines.push(`${color}${chars.v}${reset}${paddedLine1}${color}${chars.v}${reset}`)
    
    // Line 3: Active Status + Elapsed Time
    const statusIcon = "➔"
    const elapsedStr = formatDuration(this.elapsedMs)
    const statusText = truncateToWidth(this.statusText, width - 25)
    const contentLine2 = `  \x1b[32m${statusIcon}\x1b[0m  \x1b[1mStatus:\x1b[0m \x1b[36m${statusText}\x1b[0m \x1b[90m(Elapsed: ${elapsedStr})\x1b[0m`
    const visibleLen2 = displayWidth(contentLine2)
    const paddedLine2 = contentLine2 + " ".repeat(Math.max(0, width - visibleLen2 - 4))
    lines.push(`${color}${chars.v}${reset}${paddedLine2}${color}${chars.v}${reset}`)
    
    // Line 4: Live metrics (calls, tokens, hit rate) / Queued input
    let contentLine3 = ""
    if (this.queuedPrompt) {
      const truncatedQueued = truncateToWidth(this.queuedPrompt, width - 20)
      contentLine3 = `  \x1b[33m📥\x1b[0m  \x1b[1mQueued Next:\x1b[0m \x1b[90m"${truncatedQueued}"\x1b[0m`
    } else {
      let metricsStr = ""
      if (this.metrics) {
        const hitRate = (this.metrics.hitRate * 100).toFixed(1)
        metricsStr = `calls: \x1b[1m${this.metrics.calls}\x1b[0m  ·  tokens: \x1b[1m${this.metrics.inputTokens + this.metrics.outputTokens}\x1b[0m (hit: \x1b[32m${hitRate}%\x1b[0m)`
      } else {
        metricsStr = `calls: \x1b[1m0\x1b[0m  ·  tokens: \x1b[1m0\x1b[0m (hit: \x1b[32m0.0%\x1b[0m)`
      }
      contentLine3 = `  \x1b[33m📊\x1b[0m  \x1b[1mMetrics:\x1b[0m ${metricsStr}`
    }
    const visibleLen3 = displayWidth(contentLine3)
    const paddedLine3 = contentLine3 + " ".repeat(Math.max(0, width - visibleLen3 - 4))
    lines.push(`${color}${chars.v}${reset}${paddedLine3}${color}${chars.v}${reset}`)
    
    // Line 5: Bottom Border
    const hintText = ` Type /cancel to stop execution `
    const bottomH = chars.h.repeat(Math.max(0, width - hintText.length - 4))
    lines.push(`${color}${chars.bl}${chars.h.repeat(2)}${hintText}${bottomH}${chars.br}${reset}`)
    
    return lines
  }

  private renderWelcomeDashboard() {
    const width = Math.max(72, Math.min(this.getColumns(), 100))
    const session = this.context.session ?? "(selecting)"
    const model = this.context.model ?? "(provider default)"
    const logger = this.context.logger ? "on" : "off"
    const root = compactPath(this.context.root, width - 20)

    const lines = [
      `\x1b[90mEasyCode TUI | mode=${this.context.mode} provider=${this.context.provider} model=${model}\x1b[0m`,
      `\x1b[90msession=${session} logger=${logger} status=ready\x1b[0m`,
      `\x1b[90mroot=${root}\x1b[0m`,
      `\x1b[90m/help /settings /sessions /model /skill /image /thinking /effort /cancel\x1b[0m`,
      `\x1b[90m─\x1b[0m`.repeat(width - 4),
      `\x1b[1m📂 Project Root:\x1b[0m  \x1b[36m${root}\x1b[0m`,
      `\x1b[1m🤖 AI Agent:\x1b[0m     \x1b[35m${this.context.provider}\x1b[0m · model: \x1b[32m${model}\x1b[0m`,
      `\x1b[1m🔧 Run Mode:\x1b[0m     ${this.context.mode === "build" ? "\x1b[45m\x1b[37m\x1b[1m BUILD \x1b[0m" : "\x1b[44m\x1b[37m\x1b[1m PLAN \x1b[0m"}`,
      `\x1b[1m📝 Session ID:\x1b[0m   \x1b[93m${session}\x1b[0m · logger: \x1b[90m${logger}\x1b[0m`,
      `\x1b[90m─\x1b[0m`.repeat(width - 4),
      `\x1b[1m💡 Slash Commands:\x1b[0m`,
      `   \x1b[36m/help\x1b[0m      Show help details      \x1b[36m/settings\x1b[0m  View active settings`,
      `   \x1b[36m/sessions\x1b[0m  List saved sessions    \x1b[36m/model\x1b[0m     Change active model`,
      `   \x1b[36m/skill\x1b[0m     Manage skills          \x1b[36m/image\x1b[0m     Attach vision input`,
      `   \x1b[36m/cancel\x1b[0m    Stop active execution  \x1b[36mexit\x1b[0m       Exit EasyCode`
    ]

    const card = drawCard("EasyCode TUI", lines, this.getColumns(), {
      color: "\x1b[38;5;99m", // modern violet color
      borderStyle: "round",
      minWidth: 72
    })

    this.output.write("\n" + card + "\n")
    this.rendered = true
  }

  private renderSuccessSummary() {
    const lines = [
      `\x1b[1mStatus:\x1b[0m         🎉 \x1b[32m\x1b[1mSUCCESS\x1b[0m`,
      `\x1b[1mDuration:\x1b[0m       ⚡ \x1b[36m${formatDuration(this.elapsedMs)}\x1b[0m`,
    ]
    
    if (this.metrics) {
      const roundTotal = this.metrics.inputTokens + this.metrics.outputTokens
      const roundHitRate = (this.metrics.hitRate * 100).toFixed(1)
      const cumInput = this.sessionTokenUsage.inputTokens + this.metrics.inputTokens
      const cumOutput = this.sessionTokenUsage.outputTokens + this.metrics.outputTokens
      const cumCalls = this.sessionTokenUsage.calls + this.metrics.calls
      const cumTotal = cumInput + cumOutput

      lines.push(
        `\x1b[1mRound Calls:\x1b[0m    📞 \x1b[35m${this.metrics.calls}\x1b[0m`,
        `\x1b[1mRound Tokens:\x1b[0m   📊 \x1b[33m${roundTotal.toLocaleString()}\x1b[0m (cache hit: \x1b[32m${roundHitRate}%\x1b[0m)`,
        `\x1b[1mSession Calls:\x1b[0m  📞 \x1b[35m${cumCalls}\x1b[0m`,
        `\x1b[1mSession Tokens:\x1b[0m 📊 \x1b[33m${cumTotal.toLocaleString()}\x1b[0m (in: ${cumInput.toLocaleString()}, out: ${cumOutput.toLocaleString()})`
      )
    }
    
    const card = drawCard("🏁 Execution Completed", lines, this.getColumns(), {
      color: "\x1b[32m",
      borderStyle: "round"
    })
    this.writeText("\n" + card + "\n")
  }

  private renderFailureSummary(reason: string) {
    const lines = [
      `\x1b[1mStatus:\x1b[0m         ❌ \x1b[31m\x1b[1mFAILED\x1b[0m`,
      `\x1b[1mDuration:\x1b[0m       ⚡ \x1b[36m${formatDuration(this.elapsedMs)}\x1b[0m`,
      `\x1b[1mReason:\x1b[0m         ⚠️  \x1b[31m${reason}\x1b[0m`
    ]
    
    if (this.metrics) {
      const roundTotal = this.metrics.inputTokens + this.metrics.outputTokens
      const cumInput = this.sessionTokenUsage.inputTokens + this.metrics.inputTokens
      const cumOutput = this.sessionTokenUsage.outputTokens + this.metrics.outputTokens
      const cumCalls = this.sessionTokenUsage.calls + this.metrics.calls
      const cumTotal = cumInput + cumOutput

      lines.push(
        `\x1b[1mRound Calls:\x1b[0m    📞 \x1b[35m${this.metrics.calls}\x1b[0m`,
        `\x1b[1mRound Tokens:\x1b[0m   📊 \x1b[33m${roundTotal.toLocaleString()}\x1b[0m`,
        `\x1b[1mSession Calls:\x1b[0m  📞 \x1b[35m${cumCalls}\x1b[0m`,
        `\x1b[1mSession Tokens:\x1b[0m 📊 \x1b[33m${cumTotal.toLocaleString()}\x1b[0m (in: ${cumInput.toLocaleString()}, out: ${cumOutput.toLocaleString()})`
      )
    }
    
    const card = drawCard("🛑 Execution Failed", lines, this.getColumns(), {
      color: "\x1b[31m",
      borderStyle: "round"
    })
    this.writeText("\n" + card + "\n")
  }
}

function ensureTrailingNewline(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`
}

function compactPath(input: string, width: number) {
  if (input.length <= width) return input
  const tail = input.slice(Math.max(0, input.length - width + 3))
  return `...${tail}`
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += isWideCharacter(char) ? 2 : 1
  }
  return width
}

function isWideCharacter(char: string) {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

function truncateToWidth(text: string, width: number): string {
  let visibleLen = 0
  let result = ""
  let inEscape = false
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === "\x1b") {
      inEscape = true
      result += char
      continue
    }
    if (inEscape) {
      result += char
      if (char === "m") {
        inEscape = false
      }
      continue
    }
    
    const charWidth = isWideCharacter(char) ? 2 : 1
    if (visibleLen + charWidth + 3 > width) {
      result += "..."
      result += "\x1b[0m"
      break
    }
    result += char
    visibleLen += charWidth
  }
  return result
}

function drawCard(
  title: string,
  lines: string[],
  maxColumns: number,
  options: {
    color?: string
    borderStyle?: "single" | "double" | "round"
    minWidth?: number
  } = {}
): string {
  const color = options.color ?? "\x1b[36m"
  const borderStyle = options.borderStyle ?? "single"
  const minWidth = options.minWidth ?? 60

  // Calculate longest visible line length
  const maxContentLength = lines.reduce((max, line) => Math.max(max, displayWidth(line)), 0)
  const headerMinLength = title.length + 8 // Room for borders and title brackets e.g. "┌── [Title] ──"
  
  // Optimal width fits the longest line perfectly, bounded by terminal columns and minimum width
  const columns = Math.max(
    minWidth,
    Math.min(
      maxColumns,
      Math.max(maxContentLength + 4, headerMinLength)
    )
  )

  const chars = {
    single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
    double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
    round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
  }[borderStyle]

  const maxLineWidth = columns - 4
  
  const titledHeader = ` [${title}] `
  const headerLeft = chars.h.repeat(2)
  const headerRight = chars.h.repeat(Math.max(0, columns - titledHeader.length - 4))
  const topBorder = `${color}${chars.tl}${headerLeft}${titledHeader}${headerRight}${chars.tr}\x1b[0m`

  const formattedLines = lines.map(line => {
    const visibleLength = displayWidth(line)
    if (visibleLength <= maxLineWidth) {
      return `${color}${chars.v}\x1b[0m ${line}${" ".repeat(maxLineWidth - visibleLength)} ${color}${chars.v}\x1b[0m`
    } else {
      const truncated = truncateToWidth(line, maxLineWidth)
      const truncatedVisible = displayWidth(truncated)
      return `${color}${chars.v}\x1b[0m ${truncated}${" ".repeat(maxLineWidth - truncatedVisible)} ${color}${chars.v}\x1b[0m`
    }
  })

  const bottomBorder = `${color}${chars.bl}${chars.h.repeat(columns - 2)}${chars.br}\x1b[0m`

  return [topBorder, ...formattedLines, bottomBorder].join("\n")
}

function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s"
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`
  const seconds = durationMs / 1_000
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`
  return `${Math.round(seconds)}s`
}
