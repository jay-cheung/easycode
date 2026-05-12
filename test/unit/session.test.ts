import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ContextManager } from "../../src/context"
import { textMessage } from "../../src/message"
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

  test("sanitizes session ids", () => {
    expect(safeSessionID("team/default chat")).toBe("team_default_chat")
    expect(() => safeSessionID("   ")).toThrow("Session id cannot be empty")
  })
})
