import type { PermissionRequest } from "../permission"
import { TimelineRenderer, type RunUiEvent } from "./timeline"

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

export class TuiRenderer {
  private readonly timeline: TimelineRenderer
  private context: TuiContext
  private rendered = false
  private lastStatus = "ready"

  constructor(
    private readonly output: Writable = process.stdout,
    context: TuiContext,
  ) {
    this.timeline = new TimelineRenderer(output)
    this.context = context
    this.renderShell("ready")
  }

  configure(context: Partial<TuiContext>, status = this.lastStatus) {
    this.context = { ...this.context, ...context }
    this.renderShell(status)
  }

  startSession(session: string) {
    this.configure({ session }, "session selected")
  }

  event(event: RunUiEvent) {
    if (event.type === "run_start") {
      this.configure({ mode: event.mode, provider: event.provider, model: event.model }, "running")
    } else if (event.type === "provider_progress") {
      this.status(`waiting for ${event.provider}`)
    } else if (event.type === "tool_call") {
      this.status(`tool: ${event.call.name}`)
    } else if (event.type === "provider_metrics") {
      this.status("metrics")
    } else if (event.type === "failure") {
      this.status("failed")
    } else if (event.type === "run_done") {
      this.status(event.status)
    }
    this.timeline.event(event)
  }

  finish() {
    this.timeline.finish()
  }

  inputPrompt() {
    return "easycode> "
  }

  sessionPrompt() {
    return "session> "
  }

  permissionPrompt(request: PermissionRequest, text: string) {
    this.status(`permission: ${request.permission}`)
    return `[Permission]\n${text}`
  }

  planApprovalPrompt() {
    this.status("plan approval")
    return "[Plan] [A]pprove & execute  [R]eject  [E]dit plan  [N]ew prompt [A]: "
  }

  runInputHint() {
    this.status("input monitor")
    this.output.write("TUI: type /cancel to stop this run; other input is queued for the next run.\n")
  }

  queued(text: string) {
    this.status("queued input")
    this.output.write(`TUI: queued next input: ${text}\n`)
  }

  cancelling() {
    this.status("cancelling")
    this.output.write("TUI: cancelling current run...\n")
  }

  slashCommand(command: string) {
    this.status(`/${command}`)
  }

  panel(title: string, text: string) {
    this.status(title.toLowerCase())
    this.output.write(`\n[${title}]\n${ensureTrailingNewline(text)}`)
  }

  message(text: string) {
    this.output.write(ensureTrailingNewline(text))
  }

  status(status: string) {
    this.lastStatus = status
    this.output.write(`[status] ${status}\n`)
  }

  private renderShell(status: string) {
    this.lastStatus = status
    const session = this.context.session ?? "(selecting)"
    const model = this.context.model ?? "(provider default)"
    const logger = this.context.logger ? "on" : "off"
    const width = Math.max(72, Math.min(this.output.columns ?? 88, 120))
    const line = "-".repeat(width - 2)
    const root = compactPath(this.context.root, width - 10)
    const header = this.rendered ? "EasyCode TUI updated" : "EasyCode TUI"
    this.output.write(`\n+${line}+\n`)
    this.output.write(`| ${pad(header, width - 4)} |\n`)
    this.output.write(`| ${pad(`mode=${this.context.mode} provider=${this.context.provider} model=${model}`, width - 4)} |\n`)
    this.output.write(`| ${pad(`session=${session} logger=${logger} status=${status}`, width - 4)} |\n`)
    this.output.write(`| ${pad(`root=${root}`, width - 4)} |\n`)
    this.output.write(`| ${pad("/help /settings /sessions /model /skill /image /thinking /effort /cancel", width - 4)} |\n`)
    this.output.write(`+${line}+\n`)
    this.rendered = true
  }
}

function ensureTrailingNewline(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`
}

function pad(text: string, width: number) {
  if (text.length <= width) return `${text}${" ".repeat(width - text.length)}`
  return text.slice(0, Math.max(0, width - 3)) + "..."
}

function compactPath(input: string, width: number) {
  if (input.length <= width) return input
  const tail = input.slice(Math.max(0, input.length - width + 3))
  return `...${tail}`
}
