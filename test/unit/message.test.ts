import { describe, expect, test } from "bun:test"
import { canonicalizeAssistantHistory, canonicalizeHistoryMessage, createMessage, messagesToProviderInput, reasoningPart, textMessage, textPart, toolCallMessage, toolResultMessage, validProviderMessageSuffix } from "../../src/message"

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

  test("keeps delegate_subagent output compact while preserving the full coordinator summary", () => {
    const summary = "FULL_SUMMARY_" + "z".repeat(64)
    const output = `${"subagent evidence ".repeat(500)}${summary}`
    const canonical = canonicalizeHistoryMessage(toolResultMessage({
      callID: "call_delegate",
      toolName: "delegate_subagent",
      status: "succeeded",
      output,
      metadata: {
        status: "succeeded",
        subagentRole: "explorer",
        subagentStatus: "handoff",
        coordinatorSummary: summary,
      },
    }))

    const [toolPart] = canonical.parts
    if (toolPart?.type !== "tool_result") throw new Error("expected tool result")
    expect(toolPart.output).not.toBe(output)
    expect(toolPart.output).toContain("[truncated")
    expect(toolPart.metadata).toMatchObject({ historySummaryKind: "delegate_subagent_compact", historyCompacted: true })

    const provider = messagesToProviderInput([canonical])
    expect(provider[0]?.content).toContain(summary)
    expect(provider[0]?.content).toContain("<coordinator_summary>")
    expect(provider[0]?.content).toContain("[truncated")
  })

  test("renders tool results evidence-first within the configured provider budget", () => {
    const output = [
      "start",
      "x".repeat(2_000),
      "MIDDLE ERROR: expected 1 but received 2",
      "y".repeat(2_000),
      "end",
    ].join("\n")
    const message = toolResultMessage({
      callID: "call_bash",
      toolName: "bash",
      status: "failed",
      output,
      metadata: {
        status: "failed",
        command: "bun test",
        exitCode: 1,
        stdoutDiagnostics: ["MIDDLE ERROR: expected 1 but received 2"],
        truncated: true,
      },
    })

    const provider = messagesToProviderInput([message], { toolResultTokenBudget: 300 })
    const content = provider[0]?.content ?? ""

    expect(content).toContain("<evidence>")
    expect(content).toContain("status: partial")
    expect(content).toContain("source: bash")
    expect(content).toContain("MIDDLE ERROR")
    expect(content).toContain("retrievalHint:")
    expect(content.length).toBeLessThanOrEqual(1_450)
  })

  test("keeps long evidence metadata inside the configured tool result budget", () => {
    const diagnostics = Array.from({ length: 12 }, (_, index) => `ERROR diagnostic ${index} ${"details ".repeat(80)}`)
    const message = toolResultMessage({
      callID: "call_bash",
      toolName: "bash",
      status: "failed",
      output: "x".repeat(20_000),
      metadata: {
        status: "failed",
        command: `bun test ${"very-long-argument ".repeat(100)}`,
        exitCode: 1,
        stdoutDiagnostics: diagnostics,
        truncated: true,
      },
    })

    const provider = messagesToProviderInput([message], { toolResultTokenBudget: 300 })
    const toolPart = provider[0]?.parts?.find((part) => part.type === "tool_result")
    if (toolPart?.type !== "tool_result") throw new Error("expected tool result")

    expect(toolPart.output).toContain("ERROR diagnostic 0")
    expect(toolPart.output).toContain("retrievalHint:")
    expect(toolPart.output.length).toBeLessThanOrEqual(1_200)
  })

  test("keeps delegate_subagent coordinator summary complete when raw evidence is budgeted", () => {
    const summary = "COMPLETE_COORDINATOR_SUMMARY_" + "s".repeat(1_200)
    const message = toolResultMessage({
      callID: "call_delegate",
      toolName: "delegate_subagent",
      status: "succeeded",
      output: "raw ".repeat(3_000),
      metadata: {
        status: "succeeded",
        coordinatorSummary: summary,
        subagentRole: "explorer",
      },
    })

    const provider = messagesToProviderInput([message], { toolResultTokenBudget: 300 })
    const content = provider[0]?.content ?? ""

    expect(content).toContain("<coordinator_summary>")
    expect(content).toContain(summary)
    expect(content).toContain("status: partial")
  })

  test("marks delegate_subagent results partial when coordinator summary is missing", () => {
    const message = toolResultMessage({
      callID: "call_delegate",
      toolName: "delegate_subagent",
      status: "succeeded",
      output: "bounded subagent output",
      metadata: {
        status: "succeeded",
        subagentRole: "explorer",
        subagentStatus: "handoff",
      },
    })

    const content = messagesToProviderInput([message], { toolResultTokenBudget: 300 })[0]?.content ?? ""

    expect(content).toContain("status: partial")
    expect(content).toContain("retrievalHint:")
    expect(content).not.toContain("<coordinator_summary>")
  })

  test("canonicalizes assistant transcript text before logging", () => {
    const canonical = canonicalizeAssistantHistory("r".repeat(3_000), "<proposed_plan>\n" + "step\n".repeat(1_500) + "</proposed_plan>")
    expect(canonical.reasoningText).toContain("[truncated")
    expect(canonical.text).toContain("<proposed_plan>")
    expect(canonical.text).toContain("[truncated")
  })

  test("preserves full assistant reasoning in stored history", () => {
    const reasoning = "r".repeat(3_000)
    const message = canonicalizeHistoryMessage(createMessage("assistant", [reasoningPart(reasoning), textPart("done")]))
    const reasoningText = message.parts.find((part) => part.type === "reasoning")
    expect(reasoningText).toMatchObject({ type: "reasoning", text: reasoning })
  })
})
