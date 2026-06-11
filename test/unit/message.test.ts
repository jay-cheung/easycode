import { describe, expect, test } from "bun:test"
import { canonicalizeAssistantHistory, canonicalizeHistoryMessage, messagesToProviderInput, textMessage, toolCallMessage, toolResultMessage, validProviderMessageSuffix } from "../../src/message"

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

  test("canonicalizes skill and web-search tool history into compact summaries", () => {
    const skill = canonicalizeHistoryMessage(toolResultMessage({
      callID: "call_skill",
      toolName: "skill",
      status: "succeeded",
      output: "<skill_artifacts>\n- file: scripts/demo.sh\n</skill_artifacts>\nFull demo skill body",
      metadata: {
        status: "succeeded",
        skillName: "demo",
        skillDescription: "Demo skill",
        location: "/tmp/demo/SKILL.md",
        artifacts: [{ kind: "file", path: "scripts/demo.sh" }],
      },
    }))
    const web = canonicalizeHistoryMessage(toolResultMessage({
      callID: "call_web",
      toolName: "web_search",
      status: "succeeded",
      output: "",
      metadata: {
        status: "succeeded",
        query: "latest codex",
        engine: "tavily",
        count: 4,
        resultsPreview: [
          { title: "A", url: "https://a.test", snippet: "alpha" },
          { title: "B", url: "https://b.test", snippet: "beta" },
          { title: "C", url: "https://c.test", snippet: "gamma" },
          { title: "D", url: "https://d.test", snippet: "delta" },
        ],
      },
    }))

    const [skillPart] = skill.parts
    const [webPart] = web.parts
    expect(String(skillPart.type === "tool_result" ? skillPart.output : "")).toContain("Loaded skill: demo")
    expect(skillPart).toMatchObject({ type: "tool_result", metadata: expect.objectContaining({ historySummaryKind: "skill_compact", historyCompacted: true }) })
    if (skillPart.type !== "tool_result" || webPart.type !== "tool_result") throw new Error("expected tool results")
    expect(String(skillPart.output)).toContain("skill body omitted from persistent history")
    expect(String(skillPart.output)).not.toContain("Full demo skill body")
    expect(String(webPart.output)).toContain("Web search: latest codex")
    expect(String(webPart.output)).toContain("+1 more search results omitted")
  })

  test("canonicalizes assistant transcript text before logging", () => {
    const canonical = canonicalizeAssistantHistory("r".repeat(3_000), "<proposed_plan>\n" + "step\n".repeat(1_500) + "</proposed_plan>")
    expect(canonical.reasoningText).toContain("[truncated")
    expect(canonical.text).toContain("<proposed_plan>")
    expect(canonical.text).toContain("[truncated")
  })
})
