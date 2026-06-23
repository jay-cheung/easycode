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

function resolve(child: FakeChild, result: unknown = {}) {
  const request = JSON.parse(child.stdin.writes[0]) as { id: string }
  child.stdout.emitData(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
}

describe("desktop sidecar bridge environment", () => {
  test("spawns restarted sidecars with the latest main-process environment", async () => {
    const previousProvider = process.env.EASYCODE_PROVIDER
    const children: FakeChild[] = []
    const spawnOptions: Array<{ env?: NodeJS.ProcessEnv }> = []
    try {
      process.env.EASYCODE_PROVIDER = "deepseek"
      const bridge = new SidecarBridge(settings("/bin/easycode-a"), ((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawnOptions.push(options)
        const child = new FakeChild()
        children.push(child)
        return child as any
      }) as any)

      const first = bridge.request("getSettings")
      resolve(children[0])
      await first

      process.env.EASYCODE_PROVIDER = "openai-compatible"
      bridge.stop(new Error("Provider configuration changed."))
      const second = bridge.request("getSettings")
      resolve(children[1])
      await second

      expect(spawnOptions[0].env?.EASYCODE_PROVIDER).toBe("deepseek")
      expect(spawnOptions[1].env?.EASYCODE_PROVIDER).toBe("openai-compatible")
    } finally {
      if (previousProvider === undefined) delete process.env.EASYCODE_PROVIDER
      else process.env.EASYCODE_PROVIDER = previousProvider
    }
  })
})
