import { describe, expect, test } from "bun:test"
import { messagesToProviderInput, textMessage, toolCallMessage, toolResultMessage } from "../../src/message"

describe("message", () => {
  test("converts text and tool parts", () => {
    const messages = [
      textMessage("user", "hi"),
      toolCallMessage({ id: "call_1", name: "read", input: { filePath: "a.ts" } }),
      toolResultMessage({ callID: "call_1", toolName: "read", status: "succeeded", output: "ok" }),
    ]
    const provider = messagesToProviderInput(messages)
    expect(provider[0].content).toBe("hi")
    expect(provider[1].content).toContain("tool_call")
    expect(provider[2].content).toContain("tool_result")
  })
})
