import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ContextManager } from "../../src/context"
import { textMessage, toolCallMessage, toolResultMessage } from "../../src/message"
import { safeSessionID, SessionStore } from "../../src/session"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-session-"))
}

describe("session store", () => {
  test("saves and restores context messages", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager()
    context.add(textMessage("user", "hello"))
    context.add(textMessage("assistant", "hi"))
    await store.save("demo", context)

    const restored = await store.context("demo")
    expect(restored.state.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(restored.state.messages[0].parts[0]).toMatchObject({ type: "text", text: "hello" })
    await rm(root, { recursive: true, force: true })
  })

  test("prunes compacted session messages on save", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager({ preserveRecentUserTurns: 2 })
    for (let i = 0; i < 3; i += 1) {
      context.add(textMessage("user", `message ${i}`))
      context.add(textMessage("assistant", `reply ${i}`))
    }
    context.state.summary = "summary"
    await store.save("demo", context)

    const saved = await store.load("demo")
    expect(saved?.summary).toBe("summary")
    expect(saved?.messages.map((message) => message.parts[0])).toMatchObject([{ type: "text", text: "message 1" }, { type: "text", text: "reply 1" }, { type: "text", text: "message 2" }, { type: "text", text: "reply 2" }])

    const restored = await store.context("demo")
    expect(restored.state.summary).toBe("summary")
    expect(restored.state.messages.map((message) => message.parts[0])).toMatchObject([{ type: "text", text: "message 1" }, { type: "text", text: "reply 1" }, { type: "text", text: "message 2" }, { type: "text", text: "reply 2" }])
    await rm(root, { recursive: true, force: true })
  })

  test("prunes already compacted session messages on restore", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager()
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `message ${i}`))
      context.add(textMessage("assistant", `reply ${i}`))
    }
    context.state.summary = "summary"
    await store.save("demo", context)

    const restored = await store.context("demo")
    expect(restored.state.messages.length).toBe(4)
    expect(restored.state.messages[0].parts[0]).toMatchObject({ type: "text", text: "message 2" })
    await rm(root, { recursive: true, force: true })
  })

  test("does not save compacted sessions with orphan leading tool results", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager()
    context.add(toolResultMessage({ callID: "orphan", toolName: "read", status: "succeeded", output: "result" }))
    context.add(textMessage("assistant", "done"))
    context.state.summary = "summary"
    await store.save("demo", context)

    const saved = await store.load("demo")
    expect(saved?.messages.map((message) => message.role)).toEqual(["assistant"])
    const restored = await store.context("demo")
    expect(restored.state.messages.map((message) => message.role)).toEqual(["assistant"])
    await rm(root, { recursive: true, force: true })
  })


  test("redacts protected tool results on save and restore", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager()
    context.add(toolCallMessage({ id: "call_env", name: "read", input: { filePath: ".env" } }))
    context.add(toolResultMessage({ callID: "call_env", toolName: "read", status: "succeeded", output: "SECRET=hidden", metadata: { status: "succeeded", permissionAction: "ask" } }))
    await store.save("demo", context)

    const saved = await store.load("demo")
    expect(JSON.stringify(saved)).not.toContain("SECRET=hidden")
    expect(JSON.stringify(saved)).toContain("[redacted: permission-gated tool result]")

    const restored = await store.context("demo")
    expect(JSON.stringify(restored.state.messages)).not.toContain("SECRET=hidden")
    await rm(root, { recursive: true, force: true })
  })

  test("sanitizes session ids", () => {
    expect(safeSessionID("team/default chat")).toBe("team_default_chat")
    expect(() => safeSessionID("   ")).toThrow("Session id cannot be empty")
  })
})
