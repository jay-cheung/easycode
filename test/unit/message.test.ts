import { describe, expect, test } from "bun:test"
import { messagesToProviderInput, textMessage, toolCallMessage, toolResultMessage, validProviderMessageSuffix } from "../../src/message"

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

  test("drops tool results that appear before a later matching tool call", () => {
    const suffix = validProviderMessageSuffix([
      textMessage("user", "evaluate prompt"),
      toolResultMessage({ callID: "call_text_1", toolName: "bash", status: "failed", output: "bad cwd" }),
      toolResultMessage({ callID: "call_text_2", toolName: "read_lines", status: "succeeded", output: "100 | test(...)" }),
      toolCallMessage([
        { id: "call_text_1", name: "read_lines", input: { filePath: "src/prompt/compact.ts", startLine: 1, endLine: 200 } },
        { id: "call_text_2", name: "rg_search", input: { query: "compactPrompt|extractSummary", dir: "src/agent/runner.ts" } },
      ]),
      toolResultMessage({ callID: "call_text_1", toolName: "read_lines", status: "failed", output: "invalid args" }),
      toolResultMessage({ callID: "call_text_2", toolName: "rg_search", status: "failed", output: "invalid args" }),
    ])

    expect(suffix.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"])
    expect(messagesToProviderInput(suffix).map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"])
  })
})
