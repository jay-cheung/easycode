import { app } from "electron"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { existsSync } from "node:fs"
import type { DesktopSettings, SidecarFrame } from "../shared/protocol.js"

type Listener = (frame: SidecarFrame) => void

export class SidecarBridge {
  private child?: ChildProcessWithoutNullStreams
  private seq = 0
  private buffer = ""
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly listeners = new Set<Listener>()

  constructor(private settings: DesktopSettings) {}

  onFrame(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  configure(settings: DesktopSettings) {
    this.settings = settings
  }

  async request(method: string, params: Record<string, unknown> = {}) {
    this.ensureStarted()
    const id = `desktop_${++this.seq}`
    this.child?.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return await new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  stop() {
    this.child?.kill()
    this.child = undefined
  }

  private ensureStarted() {
    if (this.child && !this.child.killed) return
    const command = resolveSidecarPath(this.settings)
    this.child = spawn(command, ["sidecar", "--stdio"], { stdio: "pipe" })
    this.child.stdout.on("data", (chunk) => this.consume(String(chunk)))
    this.child.stderr.on("data", (chunk) => this.emit({ type: "event", event: { type: "fatal", message: String(chunk) } }))
    this.child.on("error", (error) => {
      this.rejectPending(error)
      this.emit({ type: "event", event: { type: "fatal", message: `Sidecar failed to start: ${error.message}` } })
    })
    this.child.on("exit", (code) => this.emit({ type: "event", event: { type: "fatal", message: `Sidecar exited with code ${code ?? "unknown"}.` } }))
  }

  private consume(chunk: string) {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline === -1) break
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      this.route(JSON.parse(line) as SidecarFrame)
    }
  }

  private route(frame: SidecarFrame) {
    if ("id" in frame) {
      const pending = this.pending.get(frame.id)
      if (pending) {
        this.pending.delete(frame.id)
        frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error.message))
      }
    }
    this.emit(frame)
  }

  private emit(frame: SidecarFrame) {
    for (const listener of this.listeners) listener(frame)
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function resolveSidecarPath(settings: DesktopSettings) {
  if (settings.sidecarPath) return settings.sidecarPath
  if (process.env.EASYCODE_DESKTOP_SIDECAR_PATH) return process.env.EASYCODE_DESKTOP_SIDECAR_PATH
  const bundled = path.join(process.resourcesPath, "sidecar", binaryName())
  if (app.isPackaged && existsSync(bundled)) return bundled
  const local = path.resolve(app.getAppPath(), "../../dist/easycode")
  if (existsSync(local)) return local
  return "easycode"
}

function binaryName() {
  if (process.platform === "win32") return "easycode-win-x64.exe"
  if (process.platform === "darwin") return process.arch === "arm64" ? "easycode-darwin-arm64" : "easycode-darwin-x64"
  return process.arch === "arm64" ? "easycode-linux-arm64" : "easycode-linux-x64"
}
