import { uiText, type UiLanguage } from "../i18n"
import type { ProviderRunMetrics } from "./timeline"
import { displayWidth, formatDuration, truncateToWidth } from "./tui-ansi"
import type { TuiContext } from "./tui-types"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

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
  lines.push(`${color}${chars.tl}${chars.h.repeat(2)}${title}${chars.h.repeat(Math.max(0, width - title.length - 4))}${chars.tr}${reset}`)

  const spinner = SPINNER_FRAMES[input.spinnerFrame]
  const modeBadge = input.context.mode === "build"
    ? "\x1b[45m\x1b[37m\x1b[1m BUILD \x1b[0m"
    : "\x1b[44m\x1b[37m\x1b[1m PLAN \x1b[0m"
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
  lines.push(`${color}${chars.bl}${chars.h.repeat(2)}${hintText}${chars.h.repeat(Math.max(0, width - hintText.length - 4))}${chars.br}${reset}`)
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
  const padded = text + " ".repeat(Math.max(0, width - visibleLength - 4))
  return `${color}${chars.v}${reset}${padded}${color}${chars.v}${reset}`
}
