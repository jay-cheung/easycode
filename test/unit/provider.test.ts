import { describe, expect, test } from "bun:test"
import { FakeProvider, OpenAIProvider, normalizeOpenAIModel, toolToResponseTool } from "../../src/provider"
import { textMessage } from "../../src/message"
import { createBuiltinRegistry } from "../../src/tool"

describe("provider", () => {
  test("fake provider emits deterministic tool calls", async () => {
    const provider = new FakeProvider()
    const events = []
    for await (const event of provider.stream({ mode: "build", prompt: "Fix the failing test", messages: [textMessage("user", "Fix")], providerMessages: [], tools: [] })) events.push(event)
    expect(events.some((event) => event.type === "tool_call")).toBe(true)
  })

  test("maps tools to Responses function schema", () => {
    const tool = createBuiltinRegistry().get("read")
    if (!tool) throw new Error("missing read tool")
    expect(toolToResponseTool(tool)).toMatchObject({ type: "function", name: "read", strict: true })
  })

  test("maps optional tool parameters to strict nullable schema", () => {
    const tool = createBuiltinRegistry().get("list")
    if (!tool) throw new Error("missing list tool")
    const responseTool = toolToResponseTool(tool)
    expect(responseTool.parameters.required).toEqual(["dirPath"])
    expect(responseTool.parameters.properties.dirPath.type).toEqual(["string", "null"])
  })

  test("normalizes common OpenAI model display casing", () => {
    expect(normalizeOpenAIModel("GPT-5.4-mini")).toBe("gpt-5.4-mini")
    expect(normalizeOpenAIModel("O3")).toBe("o3")
    expect(new OpenAIProvider("GPT-5-mini").model).toBe("gpt-5-mini")
  })
})
