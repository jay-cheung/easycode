import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AgentRunner, createRunner } from "../../src/agent"
import { ContextManager } from "../../src/context"
import { toolResults } from "../../src/message"
import { defaultPermissionRules, PermissionService } from "../../src/permission"
import { FakeProvider } from "../../src/provider"
import type { LogEvent } from "../../src/logger"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "easycode-agent-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await Bun.write(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
  await Bun.write(path.join(root, ".env"), "SECRET=x\n")
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "bun test" } }))
  await mkdir(path.join(root, "test"), { recursive: true })
  await Bun.write(path.join(root, "test", "add.test.ts"), "import { expect, test } from 'bun:test'\nimport { add } from '../src/add'\ntest('adds', () => expect(add(2, 3)).toBe(5))\n")
  return root
}

describe("agent integration", () => {
  test("build-simple-edit", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("Fix the failing test", "build")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "edit", "bash"])
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a + b")
    await rm(root, { recursive: true, force: true })
  })

  test("logger records data flow and state transitions", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const result = await createRunner({ root, provider: "fake", mode: "build", logger: (event) => events.push(event) }).run("Fix the failing test", "build")
    expect(result.status).toBe("completed")
    expect(events.some((event) => event.type === "state" && event.name === "agent.state" && event.detail?.from === "idle" && event.detail.to === "preparing")).toBe(true)
    expect(events.some((event) => event.type === "data" && event.name === "context -> provider")).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.tool_call" && event.detail?.tool === "read")).toBe(true)
    expect(events.some((event) => event.type === "tool" && event.name === "permission.evaluate" && event.detail?.tool === "edit")).toBe(true)
    expect(events.some((event) => event.type === "data" && event.name === "tool_result -> context" && event.detail?.tool === "bash")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("plan-mode-readonly", async () => {
    const root = await fixture()
    const before = await Bun.file(path.join(root, "src", "add.ts")).text()
    const result = await createRunner({ root, provider: "fake", mode: "plan" }).run("readonly-violation", "plan")
    expect(result.status).toBe("completed")
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toBe(before)
    expect(toolResults(result.messages).some((part) => part.status === "denied")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("permission-deny", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("delete tmp files", "build")
    expect(toolResults(result.messages).some((part) => part.output.includes("Permission denied"))).toBe(true)
    expect(toolResults(result.messages).some((part) => part.status === "denied")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("permission-ask-once", async () => {
    const root = await fixture()
    const permission = new PermissionService(defaultPermissionRules("build"))
    const runner = new AgentRunner({ root, provider: new FakeProvider(), permission })
    const pending = runner.run("Fix the failing test", "build")
    await new Promise((resolve) => setTimeout(resolve, 10))
    const request = [...permission.pending.values()][0]
    expect(request.permission).toBe("edit")
    permission.reply(request.id, "once")
    await new Promise((resolve) => setTimeout(resolve, 10))
    const next = [...permission.pending.values()][0]
    permission.reply(next.id, "once")
    const result = await pending
    expect(result.status).toBe("completed")
    await rm(root, { recursive: true, force: true })
  })

  test("context-compaction", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    const runner = new AgentRunner({ root, provider: new FakeProvider(), context })
    await runner.run("Fix the failing test with a very long instruction ".repeat(20), "build")
    expect(context.state.summary).toBeDefined()
    await rm(root, { recursive: true, force: true })
  })

  test("skill-progressive-loading", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nFull demo skill")
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("use skill demo", "build")
    expect(result.usedTools).toContain("skill")
    expect(toolResults(result.messages).some((part) => part.output.includes("Full demo skill"))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("sandbox-boundary", async () => {
    const root = await fixture()
    const runner = createRunner({ root, provider: "fake", mode: "build" })
    expect(() => runner.sandbox.resolve("../outside.txt")).toThrow()
    await rm(root, { recursive: true, force: true })
  })

  test("bash-timeout", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("timeout command", "build")
    expect(toolResults(result.messages).some((part) => part.metadata.timedOut === true)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
})
