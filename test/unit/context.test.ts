import { describe, expect, test } from "bun:test"
import { ContextManager } from "../../src/context"
import { toolCallMessage, toolResultMessage, textMessage } from "../../src/message"
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
    expect(context.compactionInput().some((message) => message.content.includes("message 0"))).toBe(true)
    expect(context.compact("model summary")).toBe(true)
    expect(context.state.summary).toBe("model summary")
    expect(context.state.messages.length).toBe(4)
  })

  test("compact does not preserve an orphan leading tool result", () => {
    const context = new ContextManager({ maxTokens: 10, compactAt: 0.5, preserveRecentMessages: 2 })
    context.add(textMessage("user", "long message ".repeat(10)))
    context.add(toolResultMessage({ callID: "orphan", toolName: "read", status: "succeeded", output: "result" }))
    context.add(textMessage("assistant", "done"))

    expect(context.compact("summary")).toBe(true)
    expect(context.state.messages.map((message) => message.role)).toEqual(["assistant"])
  })


  test("compose includes only skill descriptions", () => {
    const context = new ContextManager()
    const messages = context.compose({ agent: createAgent("plan"), skills: [{ name: "demo", description: "Demo skill", location: "x", content: "hidden" }], tools: [] })
    expect(messages[0].content).toContain("demo: Demo skill")
    expect(messages[0].content).not.toContain("hidden")
  })

  test("compose can omit static system context after the first provider turn", () => {
    const context = new ContextManager()
    context.add(textMessage("user", "hello"))
    const messages = context.compose()
    expect(messages.length).toBe(1)
    expect(messages[0]).toMatchObject({ role: "user", content: "hello" })
  })

  test("compaction input redacts permission-gated tool results", () => {
    const context = new ContextManager({ maxTokens: 10, compactAt: 0.5, preserveRecentMessages: 1 })
    context.add(textMessage("user", "read env"))
    context.add(toolCallMessage({ id: "call_env", name: "read", input: { filePath: ".env" } }))
    context.add(toolResultMessage({ callID: "call_env", toolName: "read", status: "succeeded", output: "SECRET=hidden", metadata: { status: "succeeded", permissionAction: "ask" } }))
    context.add(textMessage("assistant", "done"))

    const input = context.compactionInput().map((message) => message.content).join("\n")
    expect(input).not.toContain("SECRET=hidden")
    expect(input).toContain("[redacted: permission-gated tool result]")
  })
})
