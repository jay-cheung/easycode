import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentRunner } from "../../src/agent"
import { recordToolOutcome } from "../../src/agent/runner/tool-execution"
import { createBuiltinRegistry } from "../../src/tool"
import { createProvider } from "../../src/provider"
import { PermissionService, defaultPermissionRules } from "../../src/permission"
import { ContextManager } from "../../src/context"

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

  test("selected skills and pending loads are recorded in the ledger for compaction continuity", async () => {
    const root = await tmpdir()
    try {
      const skillDir = path.join(root, ".easycode", "skills", "demo")
      await mkdir(skillDir, { recursive: true })
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nDemo content")

      const runner = new AgentRunner({
        root,
        provider: createProvider("fake"),
        registry: createBuiltinRegistry(),
        permission: PermissionService.autoApprove(defaultPermissionRules("build")),
        settings: {
          provider: "fake",
          language: "en",
          thinking: true,
          effort: "high",
          selectedSkills: ["demo"],
          pendingSkillLoads: ["demo"],
          maxTokens: 32_000,
          maxSteps: 66,
        },
      })

      await runner.run("skill", "build")
      const current = runner.context.state.ledger?.current ?? []
      expect(current).toContainEqual(expect.objectContaining({ subject: "active_skills", value: "demo" }))
      expect(current).toContainEqual(expect.objectContaining({ subject: "pending_skill_loads", value: "none" }))
      expect(current).toContainEqual(expect.objectContaining({ subject: "active_capability_surface", value: expect.stringContaining("skills=demo") }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("successful retrieval tools update the active capability ledger state", () => {
    const context = new ContextManager()
    context.updateLedger({
      current: [
        {
          id: "skills",
          kind: "checkpoint",
          subject: "active_skills",
          value: "demo",
          status: "current",
          createdAtTurn: 1,
          updatedAtTurn: 1,
          evidence: { source: "assistant" },
        },
      ],
    })

    recordToolOutcome(
      { context },
      { id: "call_mcp", name: "mcp_read_resource", input: { server: "local-docs", uri: "doc://agent/retrieval" } },
      { title: "Retrieval design", output: "ok", metadata: { status: "succeeded", source: { id: "local-docs:doc://agent/retrieval" } } },
      "inspect retrieval design",
      { truncateForLedger: (text) => text, compactLine: (text) => text },
    )
    recordToolOutcome(
      { context },
      { id: "call_connector", name: "connector_call", input: { name: "docs" } },
      { title: "docs", output: "ok", metadata: { status: "succeeded", connector: "docs" } },
      "inspect docs",
      { truncateForLedger: (text) => text, compactLine: (text) => text },
    )
    recordToolOutcome(
      { context },
      { id: "call_web", name: "web_search", input: { query: "prompt caching" } },
      { title: "prompt caching", output: "ok", metadata: { status: "succeeded", engine: "tavily" } },
      "inspect web evidence",
      { truncateForLedger: (text) => text, compactLine: (text) => text },
    )

    const current = context.state.ledger?.current ?? []
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_mcp_servers", value: "local-docs" }))
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_mcp_resources", value: "doc://agent/retrieval" }))
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_connectors", value: "docs" }))
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_web_search_engine", value: "tavily" }))
    expect(current).toContainEqual(expect.objectContaining({
      subject: "active_capability_surface",
      value: expect.stringContaining("mcp_servers=local-docs"),
    }))
    expect(current).toContainEqual(expect.objectContaining({
      subject: "active_capability_surface",
      value: expect.stringContaining("web_search=tavily"),
    }))
  })
})
