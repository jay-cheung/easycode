import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentRunner } from "../../src/agent"
import { createBuiltinRegistry } from "../../src/tool"
import { createProvider } from "../../src/provider"
import { PermissionService, defaultPermissionRules } from "../../src/permission"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-runner-"))
}

describe("agent runner ui events", () => {
  test("emits immediate provider wait state after a tool result before the next model output", async () => {
    const root = await tmpdir()
    try {
      const skillDir = path.join(root, ".easycode", "skills", "demo")
      await mkdir(skillDir, { recursive: true })
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nDemo content")

      const events: string[] = []
      const runner = new AgentRunner({
        root,
        provider: createProvider("fake"),
        registry: createBuiltinRegistry(),
        permission: PermissionService.autoApprove(defaultPermissionRules("build")),
        onEvent: (event) => {
          if (event.type === "tool_result") events.push(`tool_result:${event.toolName}`)
          if (event.type === "provider_progress") events.push(`provider_progress:${event.elapsedMs}`)
          if (event.type === "text_delta") events.push(`text_delta:${event.text}`)
        },
      })

      const result = await runner.run("skill", "build")

      expect(result.status).toBe("completed")
      const toolResultIndex = events.indexOf("tool_result:skill")
      expect(toolResultIndex).toBeGreaterThan(-1)
      expect(events[toolResultIndex + 1]).toBe("provider_progress:0")
      expect(events.slice(toolResultIndex + 2)).toContain("text_delta:Skill loaded.")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
