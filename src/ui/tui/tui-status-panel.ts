import { uiText, type UiLanguage } from "../../i18n"
import type { ProviderRunMetrics } from "../timeline"
import { displayWidth, formatDuration, truncateToWidth } from "./tui-ansi"
import type { TuiContext } from "./tui-types"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function displayRunModeBadge(mode: string) {
  if (mode === "build" || mode === "plan") return "\x1b[46m\x1b[30m\x1b[1m RUN \x1b[0m"
  return `\x1b[46m\x1b[30m\x1b[1m ${mode.toUpperCase()} \x1b[0m`
}

export function spinnerFrames() {
  return SPINNER_FRAMES
}

export function generateStatusPanelLines(input: {
  context: TuiContext
  language: UiLanguage
  columns: number
  spinnerFrame: number
  elapsedMs: number
  statusText: string
  queuedPrompt?: string
  metrics?: ProviderRunMetrics
}) {
  const copy = uiText(input.language)
  const width = Math.max(60, Math.min(input.columns, 90))
  const chars = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
  const color = "\x1b[38;5;198m"
  const reset = "\x1b[0m"
  const lines: string[] = []

  const title = ` ${copy.liveMonitorTitle} `
  lines.push(drawBorderLine(title, width, { left: chars.tl, right: chars.tr, h: chars.h }, color, reset))

  const spinner = SPINNER_FRAMES[input.spinnerFrame]
  const modeBadge = displayRunModeBadge(input.context.mode)
  const providerStr = `\x1b[1m🤖 ${input.context.provider}\x1b[0m`
  const modelStr = input.context.model ? `\x1b[90m(${input.context.model})\x1b[0m` : ""
  const sessionStr = `\x1b[93msession:${input.context.session ?? "default"}\x1b[0m`
  lines.push(padPanelLine(
    `  \x1b[35m${spinner}\x1b[0m  ${modeBadge}  ${providerStr} ${modelStr}  ·  ${sessionStr}`,
    width,
    chars,
    color,
    reset,
  ))

  const elapsedStr = formatDuration(input.elapsedMs)
  const visibleStatus = truncateToWidth(input.statusText, width - 25)
  lines.push(padPanelLine(
    `  \x1b[32m➔\x1b[0m  \x1b[1m${copy.statusLabel}:\x1b[0m \x1b[36m${visibleStatus}\x1b[0m \x1b[90m(${copy.elapsedLabel}: ${elapsedStr})\x1b[0m`,
    width,
    chars,
    color,
    reset,
  ))

  if (input.context.goal) {
    const goal = input.context.goal
    lines.push(padPanelLine(
      `  \x1b[35m🎯\x1b[0m  \x1b[1m${truncateToWidth(copy.goalPanelSummary(goal.status, goal.iteration, goal.activePlanId), width - 6)}\x1b[0m`,
      width,
      chars,
      color,
      reset,
    ))
    lines.push(padPanelLine(
      `  \x1b[90m${truncateToWidth(copy.goalPanelDetail(goal.objective, goal.blocker), width - 6)}\x1b[0m`,
      width,
      chars,
      color,
      reset,
    ))
  }

  let body = ""
  if (input.queuedPrompt) {
    body = `  \x1b[33m📥\x1b[0m  \x1b[1m${copy.queuedNextLabel}:\x1b[0m \x1b[90m"${truncateToWidth(input.queuedPrompt, width - 20)}"\x1b[0m`
  } else if (input.metrics) {
    const hitRate = (input.metrics.hitRate * 100).toFixed(1)
    body = `  \x1b[33m📊\x1b[0m  \x1b[1m${copy.metricsLabel}:\x1b[0m calls: \x1b[1m${input.metrics.calls}\x1b[0m  ·  tokens: \x1b[1m${input.metrics.inputTokens + input.metrics.outputTokens}\x1b[0m (hit: \x1b[32m${hitRate}%\x1b[0m)`
  } else {
    body = `  \x1b[33m📊\x1b[0m  \x1b[1m${copy.metricsLabel}:\x1b[0m calls: \x1b[1m0\x1b[0m  ·  tokens: \x1b[1m0\x1b[0m (hit: \x1b[32m0.0%\x1b[0m)`
  }
  lines.push(padPanelLine(body, width, chars, color, reset))

  const hintText = ` ${copy.typeCancelHint} `
  lines.push(drawBorderLine(hintText, width, { left: chars.bl, right: chars.br, h: chars.h }, color, reset))
  return lines
}

function padPanelLine(
  text: string,
  width: number,
  chars: { v: string },
  color: string,
  reset: string,
) {
  const visibleLength = displayWidth(text)
  const padded = text + " ".repeat(Math.max(0, width - visibleLength - 2))
  return `${color}${chars.v}${reset}${padded}${color}${chars.v}${reset}`
}

function drawBorderLine(
  title: string,
  width: number,
  chars: { left: string; right: string; h: string },
  color: string,
  reset: string,
) {
  const prefix = chars.h.repeat(2)
  const usedWidth = 1 + displayWidth(prefix) + displayWidth(title) + 1
  const suffix = chars.h.repeat(Math.max(0, width - usedWidth))
  return `${color}${chars.left}${prefix}${title}${suffix}${chars.right}${reset}`
}
