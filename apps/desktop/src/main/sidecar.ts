import * as electron from "electron"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { existsSync } from "node:fs"
import type { DesktopSettings, SidecarFrame } from "../shared/protocol.js"

type Listener = (frame: SidecarFrame) => void
type SpawnSidecar = typeof spawn
const { app } = electron

export class SidecarBridge {
  private child?: ChildProcessWithoutNullStreams
  private lifecycleToken = 0
  private seq = 0
  private buffer = ""
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly listeners = new Set<Listener>()

  constructor(private settings: DesktopSettings, private readonly spawnSidecar: SpawnSidecar = spawn) {}

  onFrame(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  configure(settings: DesktopSettings) {
    const previousPath = this.resolvedPath()
    this.settings = settings
    const nextPath = this.resolvedPath()
    if (previousPath !== nextPath) this.stop(new Error("Sidecar path changed."))
  }

  status() {
    const sidecarPath = this.resolvedPath()
    const absolute = path.isAbsolute(sidecarPath)
    const exists = absolute ? existsSync(sidecarPath) : undefined
    return {
      path: sidecarPath,
      running: this.isRunning(),
      canReveal: Boolean(absolute && exists),
      ...(absolute ? { exists } : {}),
    }
  }

  async request(method: string, params: Record<string, unknown> = {}) {
    const child = this.ensureStarted()
    const id = `desktop_${++this.seq}`
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return await promise
  }

  stop(reason?: Error) {
    this.lifecycleToken += 1
    const child = this.child
    if (!child) return
    this.child = undefined
    this.buffer = ""
    if (reason) this.rejectPending(reason)
    child.kill()
  }

  private ensureStarted() {
    if (this.isRunning() && this.child) return this.child
    const command = this.resolvedPath()
    const args = sidecarArgs()
    const token = this.lifecycleToken
    const child = this.spawnSidecar(command, args, { stdio: "pipe", env: { ...process.env } })
    this.child = child
    child.stdout.on("data", (chunk) => {
      if (!this.isCurrentChild(child, token)) return
      this.consume(String(chunk))
    })
    child.stderr.on("data", (chunk) => {
      if (!this.isCurrentChild(child, token)) return
      this.emit({ type: "event", event: { type: "fatal", message: String(chunk) } })
    })
    child.on("error", (error) => {
      if (!this.clearChild(child, token)) return
      this.rejectPending(error)
      this.emit({ type: "event", event: { type: "fatal", message: `Sidecar failed to start: ${error.message}` } })
    })
    child.on("exit", (code) => {
      if (!this.clearChild(child, token)) return
      const message = `Sidecar exited with code ${code ?? "unknown"}.`
      this.rejectPending(new Error(message))
      this.emit({ type: "event", event: { type: "fatal", message } })
    })
    return child
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

  private isRunning() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null)
  }

  private clearChild(child: ChildProcessWithoutNullStreams, token: number) {
    if (!this.isCurrentChild(child, token)) return false
    this.child = undefined
    this.buffer = ""
    return true
  }

  private isCurrentChild(child: ChildProcessWithoutNullStreams, token: number) {
    return this.child === child && this.lifecycleToken === token
  }

  private resolvedPath() {
    return resolveSidecarPath(this.settings)
  }
}

function sidecarArgs() {
  const args = ["sidecar", "--stdio"]
  if (process.env.EASYCODE_DESKTOP_SIDECAR_INSECURE === "1" || process.env.EASYCODE_DESKTOP_SIDECAR_INSECURE === "true") {
    args.push("-k")
  }
  return args
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
