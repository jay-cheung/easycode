import { describe, expect, test } from "bun:test"
import { SidecarBridge } from "../../apps/desktop/src/main/sidecar"
import type { DesktopSettings } from "../../apps/desktop/src/shared/protocol"
import { FakeChild } from "./desktop-sidecar-fake-child"

function settings(sidecarPath: string): DesktopSettings {
  return {
    workspaceRoot: "/repo",
    sidecarPath,
    provider: "deepseek",
    language: "en",
    thinking: true,
    effort: "high",
    selectedSkills: [],
    pendingSkillLoads: [],
    session: "default",
    recentWorkspaces: ["/repo"],
  }
}

describe("desktop sidecar bridge", () => {
  test("ignores stale child output and exit after a sidecar restart", async () => {
    const children: FakeChild[] = []
    const bridge = new SidecarBridge(settings("/bin/easycode-a"), ((command: string) => {
      const child = new FakeChild()
      children.push(child)
      expect(command).toMatch(/easycode-[ab]$/)
      return child as any
    }) as any)
    const frames: unknown[] = []
    bridge.onFrame((frame) => frames.push(frame))

    const first = bridge.request("getSettings").catch((error) => error)
    bridge.configure(settings("/bin/easycode-b"))
    expect(await first).toBeInstanceOf(Error)
    expect(children[0].killed).toBe(true)

    const second = bridge.request("listSessions")
    const request = JSON.parse(children[1].stdin.writes[0]) as { id: string }
    children[0].stderr.emitData("old stderr")
    children[0].stdout.emitData(`${JSON.stringify({ id: request.id, ok: true, result: { stale: true } })}\n`)
    children[0].emit("exit", 1)
    children[1].stdout.emitData(`${JSON.stringify({ id: request.id, ok: true, result: { current: true } })}\n`)

    expect(await second).toEqual({ current: true })
    expect(frames).not.toContainEqual({ type: "event", event: { type: "fatal", message: "old stderr" } })
    expect(frames).toContainEqual({ id: request.id, ok: true, result: { current: true } })
  })
})
