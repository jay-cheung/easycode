import { buildFailureSummaryCard, buildSuccessSummaryCard, buildWelcomeDashboardCard } from "./tui-cards"
import { generateStatusPanelLines } from "./tui-status-panel"
import type { TuiState } from "./tui-state"
import type { TuiContext, Writable } from "./tui-types"
import type { SessionTokenUsage } from "../../session"
import type { UiLanguage } from "../../i18n"

type RenderLoopDeps = {
  output: Writable
  state: TuiState
  context: TuiContext
  language: UiLanguage
  columns: number
  lastPanelSnapshot: string
}

export function eraseStatusPanel(output: Writable, state: TuiState) {
  if (!state.panelDrawnLines) return
  for (let i = 0; i < state.panelDrawnLines; i++) {
    output.write("\x1b[1A\x1b[2K\r")
  }
  state.panelDrawnLines = 0
}

export function drawStatusPanel(input: RenderLoopDeps) {
  if (!input.state.shouldRenderPanel()) return input.lastPanelSnapshot

  const lines = generateStatusPanelLines({
    context: input.context,
    language: input.language,
    columns: input.columns,
    spinnerFrame: input.state.spinnerFrame,
    elapsedMs: input.state.phaseElapsedMs,
    statusText: input.state.statusText,
    queuedPrompt: input.state.queuedPrompt,
    metrics: input.state.metrics,
  })
  const snapshot = lines.join("\n")
  if (snapshot === input.lastPanelSnapshot && input.state.panelDrawnLines > 0) return input.lastPanelSnapshot

  eraseStatusPanel(input.output, input.state)
  for (const line of lines) {
    input.output.write(line + "\n")
  }
  input.state.panelDrawnLines = lines.length
  return snapshot
}

export function writeTextWithPanel(input: RenderLoopDeps, text: string) {
  if (input.state.running) {
    if (input.state.shouldWriteDirectly()) {
      input.output.write(text)
      return input.lastPanelSnapshot
    }
    eraseStatusPanel(input.output, input.state)
    input.output.write(text)
    return drawStatusPanel(input)
  }
  input.output.write(text)
  return input.lastPanelSnapshot
}

export function writeTimelineText(input: RenderLoopDeps, text: string) {
  if (input.state.running) {
    if (input.state.shouldWriteDirectly()) {
      input.output.write(text)
      return input.lastPanelSnapshot
    }
    eraseStatusPanel(input.output, input.state)
    input.output.write(text)
    if (!text.endsWith("\n")) {
      input.state.panelDirty = true
      return input.lastPanelSnapshot
    }
    return drawStatusPanel(input)
  }
  input.output.write(text)
  return input.lastPanelSnapshot
}

export function renderWelcomeDashboard(output: Writable, context: TuiContext, status: string, columns: number) {
  output.write(`\n${buildWelcomeDashboardCard(context, status, columns)}\n`)
}

export function renderSuccessSummary(output: Writable, language: UiLanguage, runElapsedMs: number, metrics: TuiState["metrics"], sessionTokenUsage: SessionTokenUsage, columns: number) {
  output.write(`\n${buildSuccessSummaryCard(language, runElapsedMs, metrics, sessionTokenUsage, columns)}\n`)
}

export function renderFailureSummary(output: Writable, language: UiLanguage, runElapsedMs: number, metrics: TuiState["metrics"], sessionTokenUsage: SessionTokenUsage, reason: string, columns: number) {
  output.write(`\n${buildFailureSummaryCard(language, runElapsedMs, metrics, sessionTokenUsage, reason, columns)}\n`)
}
