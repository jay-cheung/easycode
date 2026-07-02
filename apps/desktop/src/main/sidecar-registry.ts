import path from "node:path"

export type WorkspaceBridgeLike<Settings extends { workspaceRoot: string }> = {
  configure(settings: Settings): void
  onFrame(listener: (frame: unknown) => void): () => void
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  status(): unknown
  stop(reason?: Error): void
}

export class WorkspaceSidecarRegistry<Settings extends { workspaceRoot: string; sidecarPath?: string | undefined }> {
  private readonly bridges = new Map<string, WorkspaceBridgeLike<Settings>>()
  private readonly listeners = new Set<(frame: unknown) => void>()
  private activeKey: string | undefined
  private sidecarPath: string | undefined
  private configured = false

  constructor(private readonly createBridge: (settings: Settings) => WorkspaceBridgeLike<Settings>) {}

  configure(settings: Settings) {
    return this.configureWorkspace(settings, { activate: true })
  }

  configureWorkspace(settings: Settings, options: { activate?: boolean } = {}) {
    const key = workspaceKey(settings.workspaceRoot)
    if (this.configured && this.sidecarPath !== settings.sidecarPath) {
      this.stopAll(new Error("Sidecar path changed."))
    }
    this.configured = true
    this.sidecarPath = settings.sidecarPath
    if (options.activate !== false) this.activeKey = key
    const bridge = this.bridgeFor(key, settings)
    bridge.configure(settings)
    return bridge
  }

  request(method: string, params: Record<string, unknown> = {}) {
    return this.active().request(method, params)
  }

  requestWorkspace(workspaceRoot: string, method: string, params: Record<string, unknown> = {}) {
    return this.workspace(workspaceRoot).request(method, params)
  }

  status() {
    return this.active().status()
  }

  statusWorkspace(workspaceRoot: string) {
    return this.workspace(workspaceRoot).status()
  }

  stopActive(reason?: Error) {
    const bridge = this.activeKey ? this.bridges.get(this.activeKey) : undefined
    bridge?.stop(reason)
  }

  stopWorkspace(workspaceRoot: string, reason?: Error) {
    const key = workspaceKey(workspaceRoot)
    const bridge = this.bridges.get(key)
    if (!bridge) return false
    bridge.stop(reason)
    this.bridges.delete(key)
    if (this.activeKey === key) this.activeKey = undefined
    return true
  }

  stopAll(reason?: Error) {
    for (const bridge of this.bridges.values()) bridge.stop(reason)
    this.bridges.clear()
    this.activeKey = undefined
  }

  onFrame(listener: (frame: unknown) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activeWorkspaceKey() {
    return this.activeKey
  }

  size() {
    return this.bridges.size
  }

  private active() {
    if (!this.activeKey) throw new Error("No active workspace sidecar.")
    const bridge = this.bridges.get(this.activeKey)
    if (!bridge) throw new Error("No active workspace sidecar.")
    return bridge
  }

  private workspace(workspaceRoot: string) {
    const key = workspaceKey(workspaceRoot)
    const bridge = this.bridges.get(key)
    if (!bridge) throw new Error(`No sidecar for workspace: ${workspaceRoot}`)
    return bridge
  }

  private bridgeFor(key: string, settings: Settings) {
    const current = this.bridges.get(key)
    if (current) return current
    const bridge = this.createBridge(settings)
    bridge.onFrame((frame) => {
      if (this.activeKey !== key) return
      for (const listener of this.listeners) listener(frame)
    })
    this.bridges.set(key, bridge)
    return bridge
  }
}

export function workspaceKey(root: string) {
  return path.resolve(root)
}
