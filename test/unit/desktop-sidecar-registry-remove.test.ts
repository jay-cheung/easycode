import { describe, expect, test } from "bun:test"
import { WorkspaceSidecarRegistry, type WorkspaceBridgeLike } from "../../apps/desktop/src/main/sidecar-registry"

type TestSettings = { workspaceRoot: string; session: string }

class FakeBridge implements WorkspaceBridgeLike<TestSettings> {
  stopCount = 0
  constructor(readonly settings: TestSettings) {}
  configure() {}
  onFrame() {
    return () => undefined
  }
  async request(method: string) {
    return { method, workspaceRoot: this.settings.workspaceRoot }
  }
  status() {
    return { workspaceRoot: this.settings.workspaceRoot }
  }
  stop() {
    this.stopCount += 1
  }
}

describe("workspace sidecar registry removal", () => {
  test("stops and forgets a removed inactive workspace bridge", async () => {
    const created: FakeBridge[] = []
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => {
      const bridge = new FakeBridge(settings)
      created.push(bridge)
      return bridge
    })

    registry.configure({ workspaceRoot: "/repo/a", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", session: "default" })

    expect(registry.stopWorkspace("/repo/a", new Error("removed"))).toBe(true)
    expect(created[0].stopCount).toBe(1)
    expect(registry.size()).toBe(1)
    expect(await registry.request("listSessions")).toEqual({ method: "listSessions", workspaceRoot: "/repo/b" })
  })

  test("keeps the fallback workspace active after removing the previously active workspace", async () => {
    const created: FakeBridge[] = []
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => {
      const bridge = new FakeBridge(settings)
      created.push(bridge)
      return bridge
    })

    registry.configure({ workspaceRoot: "/repo/a", session: "default" })
    registry.configure({ workspaceRoot: "/repo/b", session: "default" })
    registry.configure({ workspaceRoot: "/repo/a", session: "scratch" })

    registry.configure({ workspaceRoot: "/repo/b", session: "default" })
    expect(registry.stopWorkspace("/repo/a", new Error("removed active workspace"))).toBe(true)

    expect(created[0].stopCount).toBe(1)
    expect(created[1].stopCount).toBe(0)
    expect(registry.size()).toBe(1)
    expect(await registry.request("listSessions")).toEqual({ method: "listSessions", workspaceRoot: "/repo/b" })
  })

  test("reports false when removing a workspace without a bridge", () => {
    const registry = new WorkspaceSidecarRegistry<TestSettings>((settings) => new FakeBridge(settings))
    registry.configure({ workspaceRoot: "/repo/b", session: "default" })

    expect(registry.stopWorkspace("/repo/a")).toBe(false)
    expect(registry.size()).toBe(1)
  })
})
