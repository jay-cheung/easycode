import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { FakeProvider } from "../../src/provider"
import { SidecarService, sidecarProtocolVersion, type SidecarEventEnvelope } from "../../src/sidecar"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "easycode-sidecar-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await mkdir(path.join(root, "test"), { recursive: true })
  await Bun.write(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
  await Bun.write(path.join(root, ".env"), "SECRET=x\n")
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "bun test" } }))
  await Bun.write(path.join(root, "test", "add.test.ts"), "import { expect, test } from 'bun:test'\nimport { add } from '../src/add'\ntest('adds', () => expect(add(2, 3)).toBe(5))\n")
  return root
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for sidecar condition")
}

describe("sidecar integration", () => {
  afterEach(() => {
    FakeProvider.clearResponses()
  })

  test("stdio sidecar initializes, lists sessions, and runs a fake-provider prompt", async () => {
    const root = await fixture()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "sidecar", "--stdio"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TAVILY_API_KEY: "tvly-test" },
    })
    const frames: any[] = []
    void readJsonLines(child.stdout, frames)
    const send = (id: string, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    }

    send("init", "initialize", { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" })
    await waitFor(() => frames.find((frame) => frame.id === "init" && frame.ok))
    send("list", "listSessions")
    await waitFor(() => frames.find((frame) => frame.id === "list" && frame.ok))
    send("run", "runPrompt", { text: "Fix the failing test" })
    await waitFor(() => frames.find((frame) => frame.type === "event" && frame.event?.type === "text_delta"))
    const done = await waitFor(() => frames.find((frame) => frame.id === "run" && frame.ok), 8_000)

    expect(done.result.status).toBe("completed")
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "tool_call")).toBe(true)
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "tool_result")).toBe(true)
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "provider_metrics")).toBe(true)
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "run_done")).toBe(true)
    expect(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).exists()).toBe(true)

    send("shutdown", "shutdown")
    child.stdin.end()
    await child.exited
    expect(await new Response(child.stderr).text()).toBe("")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("service emits permission requests and accepts replies", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("custom permission sidecar", (input) => {
      const hasEnvEdit = input.messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.toolName === "edit"))
      return hasEnvEdit
        ? [{ type: "text_delta" as const, text: "Permission path completed." }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_edit_env", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=y" } } }, { type: "done" as const }]
    })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "custom permission sidecar" } })
    const request = await waitFor(() => {
      const event = events.find((item) => item.event.type === "permission_request")
      return event?.event.type === "permission_request" ? event.event.request : undefined
    })
    await service.handle({ id: "reply", method: "replyPermission", params: { requestId: request.id, reply: "once" } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    expect(await Bun.file(path.join(root, ".env")).text()).toContain("SECRET=y")
    await rm(root, { recursive: true, force: true })
  })

  test("service emits plan approval requests and accepts replies", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "plan-exit", mode: "plan" } })
    const plan = await waitFor(() => events.find((item) => item.event.type === "plan_approval_request"))
    await service.handle({ id: "reply", method: "replyPlan", params: { runId: plan.runId, action: "approve" } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    expect(events.some((item) => item.event.type === "run_done")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })
})

async function readJsonLines(stream: ReadableStream<Uint8Array> | null, frames: any[]) {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) frames.push(JSON.parse(line))
    }
  }
}
