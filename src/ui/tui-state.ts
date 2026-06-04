import type { ProviderRunMetrics } from "./timeline"

type SpinnerTick = {
  runElapsedMs: number
  phaseElapsedMs: number
  spinnerFrame: number
}

export class TuiState {
  rendered = false
  lastStatus = "ready"
  running = false
  streaming = false
  pausedForPrompt = false
  statusText = "ready"
  runElapsedStart = 0
  runElapsedMs = 0
  phaseKey = "ready"
  phaseElapsedStart = 0
  phaseElapsedMs = 0
  spinnerFrame = 0
  panelDrawnLines = 0
  panelDirty = false
  metrics: ProviderRunMetrics | undefined = undefined
  queuedPrompt: string | undefined = undefined

  beginRun(statusText: string) {
    const now = Date.now()
    this.running = true
    this.streaming = false
    this.pausedForPrompt = false
    this.queuedPrompt = undefined
    this.metrics = undefined
    this.statusText = statusText
    this.runElapsedStart = now
    this.runElapsedMs = 0
    this.phaseKey = "run:initializing"
    this.phaseElapsedStart = now
    this.phaseElapsedMs = 0
  }

  beginStreaming(statusText: string) {
    this.pausedForPrompt = false
    this.streaming = true
    this.statusText = statusText
  }

  setStatus(statusText: string, phaseKey = statusText) {
    this.statusText = statusText
    if (phaseKey !== this.phaseKey) {
      this.phaseKey = phaseKey
      this.phaseElapsedStart = Date.now()
      this.phaseElapsedMs = 0
    }
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
    const now = Date.now()
    this.runElapsedMs = now - this.runElapsedStart
    this.phaseElapsedMs = now - this.phaseElapsedStart
    return { runElapsedMs: this.runElapsedMs, phaseElapsedMs: this.phaseElapsedMs, spinnerFrame: this.spinnerFrame }
  }

  shouldRenderPanel() {
    return this.running && !this.streaming && !this.pausedForPrompt
  }

  shouldWriteDirectly() {
    return this.streaming || this.pausedForPrompt
  }
}
