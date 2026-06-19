import { describe, expect, test } from "bun:test"
import { canonicalizeAssistantHistory, canonicalizeHistoryMessage, createMessage, messagesToProviderInput, reasoningPart, textMessage, textPart, toolCallMessage, toolResultMessage, userMessage, validProviderMessageSuffix, type Message } from "../../src/message"
import { providerToolResultStats } from "../../src/instrumentation/instrumentation-provider"

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

  test("message factories reject malformed runtime inputs", () => {
    expect(() => textMessage("user", undefined as unknown as string)).toThrow("text part must be a string")
    expect(() => userMessage(null as unknown as string)).toThrow("user message text must be a string")
    expect(() => toolCallMessage({ id: "", name: "read", input: {} })).toThrow("tool call part requires a valid tool call")
    expect(() => toolResultMessage({ callID: "call_1", toolName: "read", status: "succeeded", output: undefined as unknown as string })).toThrow("tool result output must be a string")
    expect(() => createMessage("assistant", [{ type: "text", text: undefined as unknown as string }])).toThrow("message parts contain invalid entries")
  })

  test("provider suffix normalization tolerates malformed historical messages", () => {
    const suffix = validProviderMessageSuffix([
      { id: "bad_user", role: "user", createdAt: 1 } as unknown as Message,
      toolCallMessage({ id: "call_orphan", name: "read", input: { filePath: "a.ts" } }),
      { id: "bad_tool", role: "tool", parts: undefined, createdAt: 2 } as unknown as Message,
      { id: "bad_role", role: "unknown", parts: [], createdAt: 3 } as unknown as Message,
      textMessage("assistant", "still usable"),
    ])

    expect(suffix.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(messagesToProviderInput(suffix).map((message) => message.content)).toEqual(["", "still usable"])
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

  test("folds older read_lines results for the same file into stable index cards", () => {
    const messages = [
      toolResultMessage({
        callID: "call_old",
        toolName: "read_lines",
        status: "succeeded",
        output: `old important line\n${"x".repeat(2_000)}`,
        metadata: {
          filePath: "src/file.ts",
          startLine: 40,
          endLine: 80,
          lineCount: 41,
          rawOutputLength: 2_019,
        },
      }),
      toolResultMessage({
        callID: "call_latest",
        toolName: "read_lines",
        status: "succeeded",
        output: `latest important line\n${"y".repeat(2_000)}`,
        metadata: {
          filePath: "src/file.ts",
          startLine: 1,
          endLine: 160,
          lineCount: 160,
          rawOutputLength: 2_022,
        },
      }),
    ]

    const provider = messagesToProviderInput(messages, { toolResultTokenBudget: 300 })
    const content = provider.map((message) => message.content).join("\n")
    const oldToolPart = provider[0]?.parts?.find((part) => part.type === "tool_result")

    expect(content).toContain("latest important line")
    expect(content).not.toContain("old important line")
    expect(content).toContain("file_read_range_superseded")
    expect(content).toContain("path: src/file.ts:40-80")
    expect(oldToolPart).toMatchObject({ type: "tool_result", output: expect.stringContaining("rawOutputLength: 2019") })
  })

  test("does not fold read_lines results when a later read does not cover the old range", () => {
    const messages = [
      toolResultMessage({
        callID: "call_file_0",
        toolName: "read_lines",
        status: "succeeded",
        output: `important line 0\n${"x".repeat(4_000)}`,
        metadata: {
          filePath: "src/file.ts",
          startLine: 1,
          endLine: 80,
          rawOutputLength: 4_020,
        },
      }),
      toolResultMessage({
        callID: "call_file_1",
        toolName: "read_lines",
        status: "succeeded",
        output: `important line 1\n${"x".repeat(4_000)}`,
        metadata: {
          filePath: "src/file.ts",
          startLine: 81,
          endLine: 160,
          rawOutputLength: 4_020,
        },
      }),
    ]

    const provider = messagesToProviderInput(messages, { toolResultTokenBudget: 300 })
    const content = provider.map((message) => message.content).join("\n")

    expect(content).toContain("important line 0")
    expect(content).toContain("important line 1")
    expect(content).not.toContain("file_read_range_superseded")
  })

  test("folds read_lines when a later full-file read covers it", () => {
    const provider = messagesToProviderInput([
      toolResultMessage({
        callID: "call_lines",
        toolName: "read_lines",
        status: "succeeded",
        output: "old slice only marker",
        metadata: { filePath: "src/file.ts", startLine: 5, endLine: 8 },
      }),
      toolResultMessage({
        callID: "call_read",
        toolName: "read",
        status: "succeeded",
        output: "full file including the same range",
        metadata: { filePath: "src/file.ts", lineCount: 30 },
      }),
    ])
    const content = provider.map((message) => message.content).join("\n")

    expect(content).not.toContain("old slice only marker")
    expect(content).toContain("full file including the same range")
    expect(content).toContain("file_read_range_superseded")
  })

  test("folds git_diff overview results only when a later diff view covers them", () => {
    const provider = messagesToProviderInput([
      toolResultMessage({
        callID: "call_files",
        toolName: "git_diff",
        status: "succeeded",
        output: "src/a.ts\nsrc/b.ts",
        metadata: { mode: "files" },
      }),
      toolResultMessage({
        callID: "call_patch",
        toolName: "git_diff",
        status: "succeeded",
        output: "@@ patch body",
        metadata: { mode: "file", filePath: "src/a.ts" },
      }),
      toolResultMessage({
        callID: "call_summary",
        toolName: "git_diff",
        status: "succeeded",
        output: "M src/a.ts\nM src/b.ts\nstat lines",
        metadata: { mode: "summary" },
      }),
    ])
    const content = provider.map((message) => message.content).join("\n")

    expect(content).not.toContain("src/a.ts\nsrc/b.ts")
    expect(content).toContain("@@ patch body")
    expect(content).toContain("M src/a.ts")
    expect(content).toContain("git_diff_view_superseded")
  })

  test("folds older repeated truncated git_diff file results", () => {
    const provider = messagesToProviderInput([
      toolResultMessage({
        callID: "call_old_patch",
        toolName: "git_diff",
        status: "succeeded",
        output: "@@ old truncated patch body",
        metadata: { mode: "file", filePath: "src/a.ts", truncated: true, rawOutputLength: 20_000 },
      }),
      toolResultMessage({
        callID: "call_new_patch",
        toolName: "git_diff",
        status: "succeeded",
        output: "@@ new truncated patch body",
        metadata: { mode: "file", filePath: "src/a.ts", truncated: true, rawOutputLength: 20_000 },
      }),
    ], { toolResultTokenBudget: 300 })
    const content = provider.map((message) => message.content).join("\n")

    expect(content).not.toContain("@@ old truncated patch body")
    expect(content).toContain("@@ new truncated patch body")
    expect(content).toContain("git_diff_view_superseded")
    expect(content).toContain("path: src/a.ts")
  })

  test("folds repeated query tools when the later result has a wider limit", () => {
    const provider = messagesToProviderInput([
      toolCallMessage({ id: "call_rg_1", name: "rg_search", input: { query: "token budget", dir: "src", maxResults: 10 } }),
      toolResultMessage({
        callID: "call_rg_1",
        toolName: "rg_search",
        status: "succeeded",
        output: "old ten results",
        metadata: { count: 10 },
      }),
      toolCallMessage({ id: "call_rg_2", name: "rg_search", input: { query: "token budget", dir: "src", maxResults: 50 } }),
      toolResultMessage({
        callID: "call_rg_2",
        toolName: "rg_search",
        status: "succeeded",
        output: "new fifty results",
        metadata: { count: 50 },
      }),
    ])
    const content = provider.map((message) => message.content).join("\n")

    expect(content).not.toContain("old ten results")
    expect(content).toContain("new fifty results")
    expect(content).toContain("query_result_superseded")
  })

  test("summarizes rendered provider tool result volume by tool", () => {
    const provider = messagesToProviderInput([
      toolResultMessage({ callID: "call_read", toolName: "read_lines", status: "succeeded", output: "read output", metadata: { filePath: "a.ts", startLine: 1, endLine: 3 } }),
      toolResultMessage({ callID: "call_bash", toolName: "bash", status: "failed", output: "bash error output ".repeat(50), metadata: { command: "bun test", exitCode: 1 } }),
      toolResultMessage({ callID: "call_bash_2", toolName: "bash", status: "succeeded", output: "bash ok", metadata: { command: "bun --version", exitCode: 0 } }),
    ])

    const stats = providerToolResultStats(provider)

    expect(stats.toolResultCount).toBe(3)
    expect(stats.estimatedTokens).toBeGreaterThan(0)
    expect(stats.maxTool).toBe("bash")
    expect(stats.byTool.map((item) => item.tool)).toContain("bash")
    expect(stats.byTool.find((item) => item.tool === "bash")).toMatchObject({ count: 2 })
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
