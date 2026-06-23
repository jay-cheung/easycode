import { describe, expect, test } from "bun:test"
import { WorkspaceSidecarRegistry, workspaceKey, type WorkspaceBridgeLike } from "../../apps/desktop/src/main/sidecar-registry"

type TestSettings = {
  workspaceRoot: string
  sidecarPath?: string
  session: string
}

class FakeBridge implements WorkspaceBridgeLike<TestSettings> {
  readonly frames = new Set<(frame: unknown) => void>()
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  readonly configured: TestSettings[] = []
  stopCount = 0

  constructor(settings: TestSettings) {
    this.configured.push(settings)
  }

  configure(settings: TestSettings) {
    this.configured.push(settings)
  }

  onFrame(listener: (frame: unknown) => void) {
    this.frames.add(listener)
    return () => this.frames.delete(listener)
  }

  async request(method: string, params?: Record<string, unknown>) {
    this.requests.push({ method, params })
    return { workspaceRoot: this.configured.at(-1)?.workspaceRoot, method }
  }

  status() {
    return { workspaceRoot: this.configured.at(-1)?.workspaceRoot, stopped: this.stopCount }
  }

  stop() {
    this.stopCount += 1
  }

  emit(frame: unknown) {
    for (const listener of this.frames) listener(frame)
  }
}

describe("workspace sidecar registry", () => {
  test("keeps one sidecar bridge per workspace and routes requests to the active bridge", async () => {
    const created: FakeBridge[] = []
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => {
      const bridge = new FakeBridge(settings)
      created.push(bridge)
      return bridge
    })

    registry.configure({ workspaceRoot: "/repo/a", session: "default" })
    expect(await registry.request("listSessions")).toEqual({ workspaceRoot: "/repo/a", method: "listSessions" })

    registry.configure({ workspaceRoot: "/repo/b", session: "default" })
    expect(await registry.request("listSessions")).toEqual({ workspaceRoot: "/repo/b", method: "listSessions" })

    registry.configure({ workspaceRoot: "/repo/a", session: "scratch" })
    expect(await registry.request("getSettings")).toEqual({ workspaceRoot: "/repo/a", method: "getSettings" })
    expect(created).toHaveLength(2)
    expect(registry.size()).toBe(2)
    expect(created[0].configured.at(-1)?.session).toBe("scratch")
    expect(created[0].stopCount).toBe(0)
    expect(created[1].stopCount).toBe(0)
  })

  test("emits frames only from the active workspace bridge", () => {
    const created: FakeBridge[] = []
    const frames: unknown[] = []
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => {
      const bridge = new FakeBridge(settings)
      created.push(bridge)
      return bridge
    })
    registry.onFrame((frame) => frames.push(frame))

    registry.configure({ workspaceRoot: "/repo/a", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", session: "default" })
    created[0].emit({ workspace: "a" })
    created[1].emit({ workspace: "b" })

    expect(frames).toEqual([{ workspace: "b" }])
    expect(registry.activeWorkspaceKey()).toBe(workspaceKey("/repo/b"))
  })

  test("stops existing workspace bridges when the configured sidecar path changes", () => {
    const created: FakeBridge[] = []
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => {
      const bridge = new FakeBridge(settings)
      created.push(bridge)
      return bridge
    })

    registry.configure({ workspaceRoot: "/repo/a", sidecarPath: "/bin/easycode-a", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", sidecarPath: "/bin/easycode-a", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", sidecarPath: "/bin/easycode-b", session: "default" })

    expect(created[0].stopCount).toBe(1)
    expect(created[1].stopCount).toBe(1)
    expect(registry.size()).toBe(1)
    expect(created).toHaveLength(3)
  })

  test("stops existing workspace bridges when switching from bundled sidecar resolution to a custom path", () => {
    const created: FakeBridge[] = []
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => {
      const bridge = new FakeBridge(settings)
      created.push(bridge)
      return bridge
    })

    registry.configure({ workspaceRoot: "/repo/a", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", sidecarPath: "/bin/easycode-custom", session: "default" })

    expect(created[0].stopCount).toBe(1)
    expect(created[1].stopCount).toBe(1)
    expect(registry.size()).toBe(1)
    expect(created).toHaveLength(3)
  })

  test("can restart every workspace bridge for global provider environment changes", () => {
    const created: FakeBridge[] = []
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => {
      const bridge = new FakeBridge(settings)
      created.push(bridge)
      return bridge
    })

    registry.configure({ workspaceRoot: "/repo/a", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", session: "default" })
    registry.stopAll(new Error("Provider configuration changed."))
    registry.configure({ workspaceRoot: "/repo/b", session: "default" })

    expect(created[0].stopCount).toBe(1)
    expect(created[1].stopCount).toBe(1)
    expect(registry.size()).toBe(1)
    expect(created).toHaveLength(3)
  })
})
