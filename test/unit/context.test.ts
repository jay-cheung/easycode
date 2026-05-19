import { describe, expect, test } from "bun:test"
import { ContextManager, estimateSummaryTokens, estimateTextTokens } from "../../src/context"
import { toolCallMessage, toolResultMessage, textMessage } from "../../src/message"
import { createAgent } from "../../src/agent"

describe("context", () => {
  test("uses larger default context and execution budgets", () => {
    const context = new ContextManager()
    expect(context.state.maxTokens).toBe(32_000)
    expect(context.strategyState.maxSteps).toBe(20)
    expect(context.strategyState.staticContextStrategy).toBe("every-step")
  })

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
    const context = new ContextManager({ maxTokens: 10, compactAt: 0.5, preserveRecentUserTurns: 2, compactPreserveTokens: 100 })
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

  test("compact prunes preserved recent turns to a small provider-safe suffix", () => {
    const context = new ContextManager({ maxTokens: 100, compactAt: 0.5, preserveRecentUserTurns: 2, compactPreserveTokens: 30 })
    context.add(textMessage("user", "older user"))
    context.add(textMessage("assistant", "older assistant"))
    context.add(textMessage("user", "recent user " + "x".repeat(300)))
    context.add(textMessage("assistant", "large assistant " + "y".repeat(300)))
    context.add(textMessage("user", "latest user"))
    context.add(textMessage("assistant", "latest assistant"))

    expect(context.compact("model summary")).toBe(true)
    expect(context.state.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(context.state.messages[0].parts[0]).toMatchObject({ type: "text", text: "latest user" })
    expect(context.state.tokenEstimate).toBeLessThan(80)
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

  test("compose injects structured context ledger before dynamic history", () => {
    const context = new ContextManager()
    context.setLedger({
      rules: ["Keep answers concise."],
      facts: ["User moved from New York to London."],
      preferences: ["Avoid Brand Z."],
      taskState: ["final_task: choose timezone"],
    })
    context.add(textMessage("user", "Which timezone now?"))

    const messages = context.compose({ agent: createAgent("build"), skills: [], tools: [] })
    expect(messages[0]).toMatchObject({ role: "system" })
    expect(messages[0].content).toContain("Context execution contract")
    expect(messages[1]).toMatchObject({ role: "system" })
    expect(messages[1].content).toContain("<context_state_ledger>")
    expect(messages[1].content).toContain("User moved from New York to London.")
    expect(messages[2]).toMatchObject({ role: "user", content: "Which timezone now?" })
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

  test("large historical tool outputs are truncated for token estimates and provider input", () => {
    const context = new ContextManager({ maxTokens: 20_000 })
    context.add(textMessage("user", "show logs"))
    context.add(toolResultMessage({ callID: "call_logs", toolName: "bash", status: "succeeded", output: "x".repeat(28_000) }))

    expect(context.state.tokenEstimate).toBeLessThan(4_000)
    const providerInput = context.compose().map((message) => message.content).join("\n")
    expect(providerInput).toContain("[truncated")
    expect(providerInput).not.toContain("x".repeat(9_000))
  })
})
