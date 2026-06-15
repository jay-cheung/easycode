import { languageDisplay, uiText, type UiLanguage } from "../../i18n"
import type { ProviderRunMetrics } from "../timeline"
import { compactPath, displayWidth, drawCard, formatDuration } from "./tui-ansi"
import type { TuiContext } from "./tui-types"

function displayRunMode(mode: string) {
  return mode === "build" || mode === "plan" ? "run" : mode
}

export function buildConfiguredCard(context: TuiContext, status: string, columns: number) {
  const copy = uiText(context.language ?? "en")
  const model = context.model ?? "(provider default)"
  const line = copy.tuiConfiguredLine(context.provider, model, displayRunMode(context.mode), status, languageDisplay(context.language ?? "en"))
  return drawCard(`⚙️  ${copy.tuiConfiguredTitle}`, [line], columns, {
    color: "\x1b[90m",
    borderStyle: "round",
  })
}

export function buildSessionStartedCard(language: UiLanguage, session: string, columns: number) {
  const copy = uiText(language)
  const prefix = copy.activeSession("").replace(/\s*$/, " ")
  return drawCard(`📝 ${copy.sessionStartedTitle}`, [`${prefix}\x1b[1m\x1b[38;5;99m${session}\x1b[0m`], columns, {
    color: "\x1b[38;5;99m",
    borderStyle: "round",
  })
}

export function buildPanelCard(title: string, text: string, columns: number) {
  let lines = text.split("\n")
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  const normalized = title.toLowerCase()
  return drawCard(title, lines, columns, {
    color: normalized === "help" ? "\x1b[34m" : "\x1b[36m",
    borderStyle: normalized === "help" ? "round" : "single",
    minWidth: 72,
  })
}

export function buildWelcomeDashboardCard(context: TuiContext, status: string, columns: number) {
  const language = context.language ?? "en"
  const copy = uiText(language)
  const session = context.session ?? "(selecting)"
  const model = context.model ?? "(provider default)"
  const logger = context.logger ? "on" : "off"
  const width = Math.max(72, Math.min(columns, 100))
  const root = compactPath(context.root, width - 20)
  const lines = [
    `\x1b[90m${copy.welcomeOverview(displayRunMode(context.mode), context.provider, model)}\x1b[0m`,
    `\x1b[90m${copy.welcomeSession(session, logger, status, languageDisplay(language))}\x1b[0m`,
    `\x1b[90m${copy.welcomeRoot(root)}\x1b[0m`,
    `\x1b[90m${copy.welcomeCommands}\x1b[0m`,
    `\x1b[90m─\x1b[0m`.repeat(width - 4),
    `\x1b[1m📂 ${copy.welcomeProjectRoot}\x1b[0m  \x1b[36m${root}\x1b[0m`,
    `\x1b[1m🤖 ${copy.welcomeAgent}\x1b[0m     \x1b[35m${context.provider}\x1b[0m · model: \x1b[32m${model}\x1b[0m`,
    `\x1b[1m🔧 ${copy.welcomeRunMode}\x1b[0m     \x1b[46m\x1b[30m\x1b[1m RUN \x1b[0m`,
    `\x1b[1m📝 ${copy.welcomeSessionId}\x1b[0m   \x1b[93m${session}\x1b[0m · logger: \x1b[90m${logger}\x1b[0m`,
    `\x1b[90m─\x1b[0m`.repeat(width - 4),
    `\x1b[1m💡 ${copy.welcomeSlashCommands}\x1b[0m`,
    ...copy.welcomeCommandLines,
  ]
  return drawCard(copy.welcomeTitle, lines, columns, {
    color: "\x1b[38;5;99m",
    borderStyle: "round",
    minWidth: 72,
  })
}

export function buildSuccessSummaryCard(
  language: UiLanguage,
  elapsedMs: number,
  metrics: ProviderRunMetrics | undefined,
  subagentUsage: { inputTokens: number; outputTokens: number; calls: number; invocations: number; roleCounts: Record<string, number> | Partial<Record<string, number>> },
  sessionTokenUsage: { inputTokens: number; outputTokens: number; calls: number; subagentInputTokens: number; subagentOutputTokens: number; subagentCalls: number },
  columns: number,
) {
  const copy = uiText(language)
  const lines = [
    `\x1b[1m${copy.statusLabel}:\x1b[0m         🎉 \x1b[32m\x1b[1m${copy.successStatus}\x1b[0m`,
    `\x1b[1m${copy.durationLine("").split(":")[0]}:\x1b[0m       ⚡ \x1b[36m${formatDuration(elapsedMs)}\x1b[0m`,
  ]

  if (metrics) {
    const roundTotal = metrics.inputTokens + metrics.outputTokens
    const roundHitRate = (metrics.hitRate * 100).toFixed(1)
    const cumInput = sessionTokenUsage.inputTokens + metrics.inputTokens
    const cumOutput = sessionTokenUsage.outputTokens + metrics.outputTokens
    const cumCalls = sessionTokenUsage.calls + metrics.calls
    const cumTotal = cumInput + cumOutput
    lines.push(
      copy.roundCallsLine(String(metrics.calls)),
      copy.roundTokensLine(roundTotal.toLocaleString(), `${roundHitRate}%`),
      copy.sessionCallsLine(String(cumCalls)),
      copy.sessionTokensLine(cumTotal.toLocaleString(), cumInput.toLocaleString(), cumOutput.toLocaleString()),
    )
  }
  if (subagentUsage.invocations > 0 || subagentUsage.calls > 0 || sessionTokenUsage.subagentCalls > 0) {
    const roundSubagentTotal = subagentUsage.inputTokens + subagentUsage.outputTokens
    const cumSubagentInput = sessionTokenUsage.subagentInputTokens + subagentUsage.inputTokens
    const cumSubagentOutput = sessionTokenUsage.subagentOutputTokens + subagentUsage.outputTokens
    const cumSubagentCalls = sessionTokenUsage.subagentCalls + subagentUsage.calls
    const cumSubagentTotal = cumSubagentInput + cumSubagentOutput
    const roundBreakdown = formatSubagentBreakdown(subagentUsage.roleCounts)
    lines.push(
      copy.roundSubagentInvocationsLine(String(subagentUsage.invocations)),
      ...(roundBreakdown ? [copy.roundSubagentDetailLine(roundBreakdown)] : []),
      copy.roundSubagentCallsLine(String(subagentUsage.calls)),
      copy.roundSubagentTokensLine(roundSubagentTotal.toLocaleString()),
      copy.sessionSubagentCallsLine(String(cumSubagentCalls)),
      copy.sessionSubagentTokensLine(cumSubagentTotal.toLocaleString(), cumSubagentInput.toLocaleString(), cumSubagentOutput.toLocaleString()),
    )
  }

  return drawCard(`🏁 ${copy.successTitle}`, lines, columns, {
    color: "\x1b[32m",
    borderStyle: "round",
  })
}

export function buildFailureSummaryCard(
  language: UiLanguage,
  elapsedMs: number,
  metrics: ProviderRunMetrics | undefined,
  subagentUsage: { inputTokens: number; outputTokens: number; calls: number; invocations: number; roleCounts: Record<string, number> | Partial<Record<string, number>> },
  sessionTokenUsage: { inputTokens: number; outputTokens: number; calls: number; subagentInputTokens: number; subagentOutputTokens: number; subagentCalls: number },
  reason: string,
  columns: number,
) {
  const copy = uiText(language)
  const reasonLabel = `${copy.reasonLine("").split(":")[0]}:`
  const reasonLines = wrapCardText(reasonLabel, `⚠️  ${reason}`, Math.max(24, columns - 4))
  const lines = [
    `\x1b[1m${copy.statusLabel}:\x1b[0m         ❌ \x1b[31m\x1b[1m${copy.failureStatus}\x1b[0m`,
    `\x1b[1m${copy.durationLine("").split(":")[0]}:\x1b[0m       ⚡ \x1b[36m${formatDuration(elapsedMs)}\x1b[0m`,
    ...reasonLines.map((line, index) => {
      const label = index === 0 ? reasonLabel : ""
      const spacer = index === 0 ? "         " : " ".repeat(displayWidth(reasonLabel) + 9)
      return `\x1b[1m${label}\x1b[0m${spacer}\x1b[31m${line}\x1b[0m`
    }),
  ]

  if (metrics) {
    const roundTotal = metrics.inputTokens + metrics.outputTokens
    const cumInput = sessionTokenUsage.inputTokens + metrics.inputTokens
    const cumOutput = sessionTokenUsage.outputTokens + metrics.outputTokens
    const cumCalls = sessionTokenUsage.calls + metrics.calls
    const cumTotal = cumInput + cumOutput
    lines.push(
      copy.roundCallsLine(String(metrics.calls)),
      copy.roundTokensLine(roundTotal.toLocaleString()),
      copy.sessionCallsLine(String(cumCalls)),
      copy.sessionTokensLine(cumTotal.toLocaleString(), cumInput.toLocaleString(), cumOutput.toLocaleString()),
    )
  }
  if (subagentUsage.invocations > 0 || subagentUsage.calls > 0 || sessionTokenUsage.subagentCalls > 0) {
    const roundSubagentTotal = subagentUsage.inputTokens + subagentUsage.outputTokens
    const cumSubagentInput = sessionTokenUsage.subagentInputTokens + subagentUsage.inputTokens
    const cumSubagentOutput = sessionTokenUsage.subagentOutputTokens + subagentUsage.outputTokens
    const cumSubagentCalls = sessionTokenUsage.subagentCalls + subagentUsage.calls
    const cumSubagentTotal = cumSubagentInput + cumSubagentOutput
    const roundBreakdown = formatSubagentBreakdown(subagentUsage.roleCounts)
    lines.push(
      copy.roundSubagentInvocationsLine(String(subagentUsage.invocations)),
      ...(roundBreakdown ? [copy.roundSubagentDetailLine(roundBreakdown)] : []),
      copy.roundSubagentCallsLine(String(subagentUsage.calls)),
      copy.roundSubagentTokensLine(roundSubagentTotal.toLocaleString()),
      copy.sessionSubagentCallsLine(String(cumSubagentCalls)),
      copy.sessionSubagentTokensLine(cumSubagentTotal.toLocaleString(), cumSubagentInput.toLocaleString(), cumSubagentOutput.toLocaleString()),
    )
  }

  return drawCard(`🛑 ${copy.failureTitle}`, lines, columns, {
    color: "\x1b[31m",
    borderStyle: "round",
  })
}

function wrapCardText(label: string, text: string, maxLineWidth: number) {
  const continuationPrefix = " ".repeat(displayWidth(label) + 9)
  const firstLineBudget = Math.max(12, maxLineWidth - displayWidth(label) - 9)
  const nextLineBudget = Math.max(12, maxLineWidth - displayWidth(continuationPrefix))
  const wrapped: string[] = []

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      wrapped.push("")
      continue
    }

    let current = ""
    let budget = wrapped.length === 0 ? firstLineBudget : nextLineBudget
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (displayWidth(candidate) <= budget) {
        current = candidate
        continue
      }
      if (current) wrapped.push(current)
      current = word
      budget = nextLineBudget
    }
    if (current) wrapped.push(current)
  }

  return wrapped.length > 0 ? wrapped : [text]
}

function formatSubagentBreakdown(roleCounts: Record<string, number> | Partial<Record<string, number>>) {
  const entries = Object.entries(roleCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  if (entries.length === 0) return ""
  return entries.map(([role, count]) => `${role} x${count}`).join(", ")
}
