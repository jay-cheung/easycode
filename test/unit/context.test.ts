import { describe, expect, test } from "bun:test"
import { ContextManager, estimateSummaryTokens, estimateTextTokens } from "../../src/context"
import { toolCallMessage, toolResultMessage, textMessage } from "../../src/message"
import { createAgent } from "../../src/agent"

describe("context", () => {
  test("estimates mixed-language text tokens", () => {
    expect(estimateTextTokens("abcdefghij")).toBe(3)
    expect(estimateTextTokens("中文测试")).toBe(3)
    expect(estimateTextTokens("hello中文")).toBe(3)
  })

  test("estimates message tokens", () => {
    const context = new ContextManager()
    context.add(textMessage("user", "12345678"))
    expect(context.state.tokenEstimate).toBe(3)
  })

  test("add keeps summary tokens in the estimate", () => {
    const context = new ContextManager()
    context.state.summary = "existing summary"
    context.add(textMessage("user", "hello"))
    expect(context.state.tokenEstimate).toBe(context.estimate(context.state.messages) + estimateSummaryTokens("existing summary"))
  })

  test("compacts and preserves recent user turns", () => {
    const context = new ContextManager({ maxTokens: 10, compactAt: 0.5, preserveRecentUserTurns: 2 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `message ${i} with enough content`))
      context.add(textMessage("assistant", `response ${i}`))
    }
    expect(context.compactionInput().some((message) => message.content.includes("message 0"))).toBe(true)
    expect(context.compact("model summary")).toBe(true)
    expect(context.state.summary).toBe("model summary")
    expect(context.state.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(context.state.messages[0].parts[0]).toMatchObject({ type: "text", text: "message 2 with enough content" })
  })

  test("compact does not preserve an orphan leading tool result", () => {
    const context = new ContextManager({ maxTokens: 1, compactAt: 0.5 })
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
    const context = new ContextManager({ maxTokens: 10, compactAt: 0.5, preserveRecentUserTurns: 1 })
    context.add(textMessage("user", "read env"))
    context.add(toolCallMessage({ id: "call_env", name: "read", input: { filePath: ".env" } }))
    context.add(toolResultMessage({ callID: "call_env", toolName: "read", status: "succeeded", output: "SECRET=hidden", metadata: { status: "succeeded", permissionAction: "ask" } }))
    context.add(textMessage("assistant", "done"))
    context.add(textMessage("user", "next turn with enough content to keep recent"))

    const input = context.compactionInput().map((message) => message.content).join("\n")
    expect(input).not.toContain("SECRET=hidden")
    expect(input).toContain("[redacted: permission-gated tool result]")
  })

  test("compaction token estimate decreases when summary is shorter than compacted history", () => {
    const context = new ContextManager({ maxTokens: 100, compactAt: 0.5, preserveRecentUserTurns: 1 })
    context.state.summary = "previous summary"
    for (let i = 0; i < 4; i += 1) context.add(textMessage("user", `历史消息 ${i} `.repeat(20)))
    const before = context.state.tokenEstimate

    expect(context.compact("short summary")).toBe(true)
    expect(context.state.tokenEstimate).toBeLessThan(before)
  })
})
