import type { ProviderRunMetrics } from "./timeline"

type SpinnerTick = {
  elapsedMs: number
  spinnerFrame: number
}

export class TuiState {
  rendered = false
  lastStatus = "ready"
  running = false
  streaming = false
  pausedForPrompt = false
  statusText = "ready"
  elapsedStart = 0
  elapsedMs = 0
  spinnerFrame = 0
  panelDrawnLines = 0
  panelDirty = false
  metrics: ProviderRunMetrics | undefined = undefined
  queuedPrompt: string | undefined = undefined

  beginRun(statusText: string) {
    this.running = true
    this.streaming = false
    this.pausedForPrompt = false
    this.queuedPrompt = undefined
    this.metrics = undefined
    this.statusText = statusText
    this.elapsedStart = Date.now()
    this.elapsedMs = 0
  }

  beginStreaming(statusText: string) {
    this.pausedForPrompt = false
    this.streaming = true
    this.statusText = statusText
  }

  stopStreaming() {
    this.streaming = false
  }

  resolvePrompt() {
    this.pausedForPrompt = false
  }

  pauseForPrompt() {
    this.pausedForPrompt = true
  }

  finishRun() {
    this.running = false
    this.streaming = false
    this.pausedForPrompt = false
  }

  tickSpinner(frameCount: number): SpinnerTick {
    this.spinnerFrame = (this.spinnerFrame + 1) % frameCount
    this.elapsedMs = Date.now() - this.elapsedStart
    return { elapsedMs: this.elapsedMs, spinnerFrame: this.spinnerFrame }
  }

  shouldRenderPanel() {
    return this.running && !this.streaming && !this.pausedForPrompt
  }

  shouldWriteDirectly() {
    return this.streaming || this.pausedForPrompt
  }
}
