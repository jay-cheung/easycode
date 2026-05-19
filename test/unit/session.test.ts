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

  test("saves and restores session settings", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager()
    context.add(textMessage("user", "hello"))
    await store.save("demo", context, { provider: "openai", model: "gpt-5-mini", thinking: false, effort: "max", selectedSkills: ["demo"], cacheStrategy: "cache-heavy" })

    const saved = await store.load("demo")
    expect(saved?.settings).toMatchObject({ provider: "openai", model: "gpt-5-mini", thinking: false, effort: "max", selectedSkills: ["demo"], cacheStrategy: "cache-heavy" })
    expect(await store.settings("demo", "fake")).toMatchObject({ provider: "openai", model: "gpt-5-mini", thinking: false, effort: "max", selectedSkills: ["demo"], cacheStrategy: "cache-heavy" })
    await rm(root, { recursive: true, force: true })
  })

  test("saves and restores context ledger", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager()
    context.setLedger({ facts: ["User lives in London."], preferences: ["Avoid Brand Z."] })
    context.add(textMessage("user", "remember this"))
    await store.save("demo", context)

    const saved = await store.load("demo")
    expect(saved?.ledger).toMatchObject({ facts: ["User lives in London."], preferences: ["Avoid Brand Z."] })
    const restored = await store.context("demo")
    expect(restored.state.ledger).toMatchObject({ facts: ["User lives in London."], preferences: ["Avoid Brand Z."] })
    expect(restored.compose({ agent: { name: "test", mode: "build", systemPrompt: "test" }, skills: [], tools: [] }).map((message) => message.content).join("\n")).toContain("User lives in London.")
    await rm(root, { recursive: true, force: true })
  })

  test("prunes compacted session messages on save", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager({ preserveRecentUserTurns: 2, compactPreserveTokens: 100 })
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
    const context = new ContextManager({ activeWindowUserTurns: 2, compactPreserveTokens: 100 })
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

  test("truncates large historical outputs on save and restore", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager()
    context.add(textMessage("user", "inspect output"))
    context.add(toolResultMessage({ callID: "call_large", toolName: "bash", status: "succeeded", output: "x".repeat(28_000) }))
    context.add(textMessage("assistant", "y".repeat(28_000)))
    await store.save("demo", context)

    const saved = await store.load("demo")
    expect(JSON.stringify(saved)).toContain("[truncated")
    expect(JSON.stringify(saved)).not.toContain("x".repeat(9_000))
    expect(JSON.stringify(saved)).not.toContain("y".repeat(9_000))

    const restored = await store.context("demo")
    expect(restored.state.tokenEstimate).toBeLessThan(6_000)
    expect(JSON.stringify(restored.state.messages)).toContain("[truncated")
    await rm(root, { recursive: true, force: true })
  })

  test("saves compacted sessions with only a small recent suffix", async () => {
    const root = await tmpdir()
    const store = new SessionStore(root)
    const context = new ContextManager({ preserveRecentUserTurns: 2, compactPreserveTokens: 30 })
    context.add(textMessage("user", "older user"))
    context.add(textMessage("assistant", "older assistant"))
    context.add(textMessage("user", "recent user " + "x".repeat(300)))
    context.add(textMessage("assistant", "large assistant " + "y".repeat(300)))
    context.add(textMessage("user", "latest user"))
    context.add(textMessage("assistant", "latest assistant"))
    context.state.summary = "summary"
    await store.save("demo", context)

    const saved = await store.load("demo")
    expect(saved?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(saved?.messages[0].parts[0]).toMatchObject({ type: "text", text: "latest user" })

    const restored = await store.context("demo")
    expect(restored.state.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(restored.state.tokenEstimate).toBeLessThan(80)
    await rm(root, { recursive: true, force: true })
  })

  test("sanitizes session ids", () => {
    expect(safeSessionID("team/default chat")).toBe("team_default_chat")
    expect(() => safeSessionID("   ")).toThrow("Session id cannot be empty")
  })
})
