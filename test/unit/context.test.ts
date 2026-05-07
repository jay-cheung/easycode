import { describe, expect, test } from "bun:test"
import { ContextManager } from "../../src/context"
import { textMessage } from "../../src/message"
import { createAgent } from "../../src/agent"

describe("context", () => {
  test("estimates tokens", () => {
    const context = new ContextManager()
    context.add(textMessage("user", "12345678"))
    expect(context.state.tokenEstimate).toBe(2)
  })

  test("compacts and preserves recent messages", () => {
    const context = new ContextManager({ maxTokens: 10, compactAt: 0.5, preserveRecentMessages: 4 })
    for (let i = 0; i < 8; i += 1) context.add(textMessage("user", `message ${i} with enough content`))
    expect(context.compact()).toBe(true)
    expect(context.state.summary).toContain("message")
    expect(context.state.messages.length).toBe(4)
  })

  test("compose includes only skill descriptions", () => {
    const context = new ContextManager()
    const messages = context.compose({ agent: createAgent("plan"), skills: [{ name: "demo", description: "Demo skill", location: "x", content: "hidden" }], tools: [] })
    expect(messages[0].content).toContain("demo: Demo skill")
    expect(messages[0].content).not.toContain("hidden")
  })
})
