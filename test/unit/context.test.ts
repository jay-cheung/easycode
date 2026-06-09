import { describe, expect, test } from "bun:test"
import { ContextManager, estimateMessages, estimateSummaryTokens, estimateTextTokens, recentProviderMessageSuffix, type LedgerKind, type LedgerRecord, type LedgerStatus } from "../../src/context"
import { toolCallMessage, toolResultMessage, textMessage } from "../../src/message"
import { createAgent } from "../../src/agent"
import { createBuiltinRegistry } from "../../src/tool"
import { providerMessageToResponseInput } from "../../src/provider"

describe("context", () => {
  test("uses larger default context and execution budgets", () => {
    const context = new ContextManager()
    expect(context.state.maxTokens).toBe(32_000)
    expect(context.strategyState.maxSteps).toBe(66)
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

  test("compact returns false below threshold without mutating state", () => {
    const context = new ContextManager({ maxTokens: 32_000, compactAt: 0.9 })
    context.state.summary = "existing summary"
    context.add(textMessage("user", "short request"))
    const messages = [...context.state.messages]
    const tokenEstimate = context.state.tokenEstimate

    expect(context.compact("new summary")).toBe(false)
    expect(context.state.summary).toBe("existing summary")
    expect(context.state.messages).toEqual(messages)
    expect(context.state.tokenEstimate).toBe(tokenEstimate)
  })

  test("recent provider suffix preserves a trailing tool exchange as a pair", () => {
    const suffix = recentProviderMessageSuffix([
      toolCallMessage({ id: "call_1", name: "read", input: { filePath: "a.ts" } }),
      toolResultMessage({ callID: "call_1", toolName: "read", status: "succeeded", output: "ok" }),
    ], 100)

    expect(suffix.map((message) => message.role)).toEqual(["assistant", "tool"])
  })

  test("recent provider suffix drops a trailing tool exchange when the result does not fit", () => {
    const suffix = recentProviderMessageSuffix([
      toolCallMessage({ id: "call_1", name: "read", input: { filePath: "a.ts" } }),
      toolResultMessage({ callID: "call_1", toolName: "read", status: "succeeded", output: "x".repeat(10_000) }),
    ], 10)

    expect(suffix).toEqual([])
  })

  test("recent provider suffix keeps the latest user turn instead of an assistant-only tail", () => {
    const user = textMessage("user", "recent user " + "x".repeat(300))
    const assistant = textMessage("assistant", "recent assistant")
    const budget = estimateMessages([user])

    expect(estimateMessages([user, assistant])).toBeGreaterThan(budget)

    const suffix = recentProviderMessageSuffix([user, assistant], budget)
    expect(suffix.map((message) => message.role)).toEqual(["user"])
  })

  test("compact keeps the latest user turn when the latest full turn exceeds the preserve budget", () => {
    const latestUserText = "recent user " + "x".repeat(300)
    const latestUser = textMessage("user", latestUserText)
    const latestAssistant = textMessage("assistant", "recent assistant")
    const context = new ContextManager({ maxTokens: 100, compactAt: 0.5, preserveRecentUserTurns: 1, compactPreserveTokens: estimateMessages([latestUser]) })

    context.add(textMessage("user", "older user with enough content"))
    context.add(textMessage("assistant", "older assistant"))
    context.add(latestUser)
    context.add(latestAssistant)

    expect(context.compact("model summary")).toBe(true)
    expect(context.state.messages.map((message) => message.role)).toEqual(["user"])
    expect(context.state.messages[0].parts[0]).toMatchObject({ type: "text", text: latestUserText })
  })

  test("compose after summary emits only paired Responses tool history", () => {
    const context = new ContextManager()
    context.state.summary = "model summary"
    context.add(toolCallMessage([
      { id: "call_read", name: "read", input: { filePath: "a.ts" } },
      { id: "call_list", name: "list", input: { dirPath: "." } },
    ]))
    context.add(toolResultMessage({ callID: "call_read", toolName: "read", status: "succeeded", output: "ok" }))

    const responseInput = context.compose({ agent: createAgent("build"), skills: [], tools: [] }).flatMap(providerMessageToResponseInput)
    const calls = responseInput.filter((item) => item.type === "function_call").map((item) => item.call_id)
    const outputs = responseInput.filter((item) => item.type === "function_call_output").map((item) => item.call_id)

    expect(calls).toEqual(outputs)
  })

  test("compose after summary drops tool results that precede a later assistant tool call", () => {
    const context = new ContextManager()
    context.state.summary = "model summary"
    context.add(textMessage("user", "evaluate prompt"))
    context.add(toolResultMessage({ callID: "call_text_1", toolName: "bash", status: "failed", output: "bad cwd" }))
    context.add(toolResultMessage({ callID: "call_text_2", toolName: "read_lines", status: "succeeded", output: "100 | test(...)" }))
    context.add(toolCallMessage([
      { id: "call_text_1", name: "read_lines", input: { filePath: "src/prompt/compact.ts", startLine: 1, endLine: 200 } },
      { id: "call_text_2", name: "rg_search", input: { query: "compactPrompt|extractSummary", dir: "src/agent/runner.ts" } },
    ]))
    context.add(toolResultMessage({ callID: "call_text_1", toolName: "read_lines", status: "failed", output: "invalid args" }))
    context.add(toolResultMessage({ callID: "call_text_2", toolName: "rg_search", status: "failed", output: "invalid args" }))

    const responseInput = context.compose({ agent: createAgent("build"), skills: [], tools: [] }).flatMap(providerMessageToResponseInput)

    expect(responseInput.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual(["call_text_1", "call_text_2"])
    expect(responseInput.find((item) => item.type === "message" && item.role === "user" && item.content.some((part) => part.text?.includes("bad cwd")))).toBeUndefined()
  })


  test("compose includes only skill descriptions", () => {
    const context = new ContextManager()
    const messages = context.compose({ agent: createAgent("plan"), skills: [{ id: "demo", name: "demo", description: "Demo skill", location: "x", content: "hidden" }], tools: [] })
    expect(messages[0].content).not.toContain("demo: Demo skill")
    expect(messages[1].content).toContain("demo: Demo skill")
    expect(messages[1].content).not.toContain("hidden")
  })

  test("compose includes durable instructions before dynamic history", () => {
    const context = new ContextManager()
    context.add(textMessage("user", "hello"))
    const messages = context.compose({ agent: createAgent("build"), instructions: [{ source: "project", path: "AGENTS.md", content: "Prefer repo-local rules." }], skills: [], tools: [] })

    expect(messages[1].content).toContain('<instruction source="project" path="AGENTS.md">')
    expect(messages[1].content).toContain("Prefer repo-local rules.")
    expect(messages[2]).toMatchObject({ role: "user", content: "hello" })
  })

  test("compose requires first-use load for pending selected skills", () => {
    const context = new ContextManager()
    const demo = { id: "demo", name: "demo", description: "Demo skill", location: "x", content: "hidden" }
    const messages = context.compose({ agent: createAgent("build"), skills: [demo], selectedSkills: [demo], pendingSkillLoads: [demo], tools: [] })

    expect(messages[1].content).toContain("First-use skill load required")
    expect(messages[1].content).toContain("MUST call the skill tool")
    expect(messages[1].content).toContain("demo: Demo skill")
    expect(messages[1].content).not.toContain("hidden")
  })

  test("compose keeps tool policy without duplicating provider tool definitions in the system prompt", () => {
    const context = new ContextManager()
    const readTool = createBuiltinRegistry().get("read")
    if (!readTool) throw new Error("missing read tool")

    const messages = context.compose({ agent: createAgent("build"), skills: [], tools: [readTool] })

    expect(messages[0].content).toContain("Navigation and cache contract")
    expect(messages[0].content).toContain("symbol-aware edit plan")
    expect(messages[0].content).toContain("excluded same-name matches")
    expect(messages[0].content).not.toContain("Available tools:")
    expect(messages[0].content).not.toContain("- read:")
    expect(messages[0].content).not.toContain("input_schema")
    expect(messages[0].content).not.toContain("additionalProperties")
  })

  test("cache stats report current and maximum static prefix tokens separately", () => {
    const context = new ContextManager()
    const baseAgent = createAgent("build")
    const verboseAgent = { ...baseAgent, systemPrompt: `${baseAgent.systemPrompt}\n${"extra context ".repeat(100)}` }

    const first = context.planRequest({ step: 0, agent: verboseAgent, skills: [], tools: [] }).cacheStats
    const second = context.planRequest({ step: 1, agent: baseAgent, skills: [], tools: [] }).cacheStats

    expect(first.currentStaticPrefixTokens).toBeGreaterThan(second.currentStaticPrefixTokens)
    expect(first.maxStaticPrefixTokens).toBe(first.currentStaticPrefixTokens)
    expect(second.maxStaticPrefixTokens).toBe(first.currentStaticPrefixTokens)
    expect(second.staticPrefixTokens).toBe(second.currentStaticPrefixTokens)
  })

  test("configureStrategy clamps context budgets without changing maxSteps", () => {
    const context = new ContextManager()

    context.configureStrategy({ compactAt: 0, maxSteps: 1, toolResultTokenBudget: 1, dynamicSummaryTokenBudget: 1 })
    expect(context.strategyState).toMatchObject({
      compactAt: 0.6,
      maxSteps: 1,
      toolResultTokenBudget: 300,
      dynamicSummaryTokenBudget: 800,
    })

    context.configureStrategy({ compactAt: 1, maxSteps: 100, toolResultTokenBudget: 10_000, dynamicSummaryTokenBudget: 20_000 })
    expect(context.strategyState).toMatchObject({
      compactAt: 0.9,
      maxSteps: 100,
      toolResultTokenBudget: 4_000,
      dynamicSummaryTokenBudget: 8_000,
    })
  })

  test("compose without input omits static agent and tool system context", () => {
    const context = new ContextManager()
    context.state.summary = "known summary"
    context.add(textMessage("user", "hello"))

    const messages = context.compose()
    const content = messages.map((message) => message.content).join("\n")

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("known summary") })
    expect(content.includes("Context execution contract")).toBe(false)
    expect(content.includes("Navigation and cache contract")).toBe(false)
    expect(messages[1]).toMatchObject({ role: "user", content: "hello" })
  })

  test("compose keeps structured context ledger out of provider messages by default", () => {
    const context = new ContextManager()
    context.setLedger({
      current: [
        ledgerRecord("constraint", "answer_style", "Keep answers concise.", "current", 1),
        ledgerRecord("entity", "location", "User moved from New York to London.", "current", 1),
        ledgerRecord("preference", "brand_filter", "Avoid Brand Z.", "current", 1),
        ledgerRecord("intent", "final_task", "choose timezone", "current", 1),
      ],
    })
    context.add(textMessage("user", "Which timezone now?"))

    const messages = context.compose({ agent: createAgent("build"), skills: [], tools: [] })
    expect(messages[0]).toMatchObject({ role: "system" })
    expect(messages[0].content).toContain("Context execution contract")
    expect(messages[1]).toMatchObject({ role: "user", content: "Which timezone now?" })
    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.content).join("\n")).not.toContain("<context_state_ledger>")

    const ledger = context.selectedLedgerText()
    expect(ledger).toContain("<context_state_ledger>")
    expect(ledger).not.toContain("current:")
    expect(ledger).not.toContain("history:")
    expect(ledger).toContain("User moved from New York to London.")
  })

  test("ledger renders as one chronological list with latest records last", () => {
    const context = new ContextManager()
    context.setLedger({
      current: [ledgerRecord("intent", "latest", "latest value", "current", 3)],
      history: [ledgerRecord("intent", "older", "older value", "superseded", 1)],
    })

    const ledger = context.selectedLedgerText()
    expect(ledger).not.toContain("current:")
    expect(ledger).not.toContain("history:")
    expect(ledger.indexOf("older value")).toBeLessThan(ledger.indexOf("latest value"))
  })

  test("ledger selector always keeps current user trace and active capability state", () => {
    const context = new ContextManager()
    context.setLedger({
      current: [
        ledgerRecord("intent", "current_user_input", "继续，压缩后的提示词里一定要保留当前用户的要求", "current", 2),
        ledgerRecord("checkpoint", "active_capability_surface", "skills=easycode-slice-loop; mcp_servers=local-docs; connectors=docs; web_search=tavily; plugins=none (EasyCode v1 runtime)", "current", 2),
        ledgerRecord("file", "README.md", "unrelated file note", "current", 2, { scope: { files: ["README.md"] } }),
      ],
    })
    context.add(textMessage("user", "Patch src/agent/runner/index.ts only."))

    const ledger = context.selectedLedgerText()
    expect(ledger).toContain("current_user_input")
    expect(ledger).toContain("active_capability_surface")
    expect(ledger).not.toContain("unrelated file note")
  })

  test("ledger updates replace keyed current-state entries", () => {
    const context = new ContextManager()
    context.updateLedger({
      current: [
        ledgerRecord("intent", "current_user_request", "run a partial probe", "current", 1),
        ledgerRecord("intent", "main_objective", "old objective", "current", 1),
        ledgerRecord("entity", "last_tool_failure", "old failure", "current", 1),
      ],
    })
    context.updateLedger({
      current: [
        ledgerRecord("intent", "current_user_request", "run the full APIx suite", "current", 2),
        ledgerRecord("intent", "main_objective", "latest objective", "current", 2),
        ledgerRecord("entity", "last_tool_failure", "path boundary failure", "current", 2),
      ],
    })

    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "intent", subject: "current_user_request", value: "run the full APIx suite", status: "current" }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "intent", subject: "main_objective", value: "latest objective", status: "current" }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "entity", subject: "last_tool_failure", value: "path boundary failure", status: "current" }))
    expect(context.state.ledger?.history).toContainEqual(expect.objectContaining({ kind: "intent", subject: "current_user_request", value: "run a partial probe", status: "superseded" }))
    expect(context.state.ledger?.history).toContainEqual(expect.objectContaining({ kind: "entity", subject: "last_tool_failure", value: "old failure", status: "superseded" }))
  })

  test("ledger updates normalize patch data without retaining patch references", () => {
    const context = new ContextManager()
    const patch = {
      current: [ledgerRecord("intent", "main_objective", "old objective", "current", 1)],
    }

    context.updateLedger(patch)
    patch.current[0].value = "mutated outside"
    context.updateLedger({ current: [ledgerRecord("intent", "main_objective", "new objective", "current", 2)] })

    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "main_objective", value: "new objective", status: "current" }))
    expect(context.state.ledger?.history).toContainEqual(expect.objectContaining({ subject: "main_objective", value: "old objective", status: "superseded" }))
    expect(context.state.ledger?.history).not.toContainEqual(expect.objectContaining({ value: "mutated outside" }))
  })

  test("ledger updates skip identical current-state records", () => {
    const context = new ContextManager()
    const record = ledgerRecord("constraint", "main_objective", "complete latest request end-to-end", "current", 1)

    context.updateLedger({ current: [record] })
    context.updateLedger({ current: [ledgerRecord("constraint", "main_objective", "complete latest request end-to-end", "current", 2)] })

    expect(context.state.ledger?.current).toHaveLength(1)
    expect(context.state.ledger?.history ?? []).toHaveLength(0)
  })

  test("structured ledger preserves rejected history with reasons", () => {
    const context = new ContextManager()
    context.setLedger({
      current: [ledgerRecord("decision", "auth_strategy", "方案 B: 增加重试逻辑", "current", 2)],
      history: [ledgerRecord("decision", "auth_strategy", "方案 A: 增加超时时间", "rejected", 1, { reason: "用户认为治标不治本" })],
    })
    context.add(textMessage("user", "为什么之前不用方案 A？"))

    const ledger = context.selectedLedgerText()
    expect(ledger).toContain("方案 B: 增加重试逻辑")
    expect(ledger).toContain("方案 A: 增加超时时间")
    expect(ledger).toContain("用户认为治标不治本")
  })

  test("ledger selector omits unrelated file records", () => {
    const context = new ContextManager()
    context.setLedger({
      current: [
        ledgerRecord("file", "src/auth.ts", "auth timeout fix is pending verification", "current", 1, { scope: { files: ["src/auth.ts"] } }),
        ledgerRecord("file", "README.md", "readme copy was updated", "current", 1, { scope: { files: ["README.md"] } }),
      ],
    })
    context.add(textMessage("user", "继续改 src/auth.ts 的测试"))

    const ledger = context.selectedLedgerText()
    expect(ledger).toContain("auth timeout fix is pending verification")
    expect(ledger).not.toContain("readme copy was updated")
  })

  test("summary conflicts are recorded without overriding current ledger", () => {
    const context = new ContextManager({ maxTokens: 10, compactAt: 0.5 })
    context.setLedger({ current: [ledgerRecord("intent", "current_user_request", "run full APIx suite", "current", 1)] })
    context.add(textMessage("user", "x ".repeat(80)))

    expect(context.compact("current_user_request: run partial probe")).toBe(true)
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "intent", subject: "current_user_request", value: "run full APIx suite" }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "conflict", subject: "summary_conflict:current_user_request", value: expect.stringContaining("run partial probe") }))
  })

  test("token estimate excludes dynamic ledger until the ledger tool is called", () => {
    const context = new ContextManager()
    context.setLedger({
      current: [ledgerRecord("intent", "current_user_request", "say hello", "current", 1)],
      history: Array.from({ length: 20 }, (_, index) => ledgerRecord("checkpoint", `old_${index}`, "x".repeat(500), "archived", index)),
    })
    context.add(textMessage("user", "hello"))

    expect(context.state.tokenEstimate).toBe(context.estimate(context.state.messages))
    const input = context.compose({ agent: createAgent("build"), skills: [], tools: [] }).map((message) => message.content).join("\n")
    expect(input).not.toContain("say hello")
    expect(input).not.toContain("x".repeat(200))
    expect(context.selectedLedgerText()).toContain("say hello")
  })

  test("setLedger undefined and clearLedger remove ledger without changing message estimate", () => {
    const context = new ContextManager()
    context.add(textMessage("user", "hello"))
    const messageEstimate = context.state.tokenEstimate

    context.setLedger({ current: [ledgerRecord("intent", "current_user_request", "say hello", "current", 1)] })
    expect(context.state.ledger?.current).toHaveLength(1)
    expect(context.state.tokenEstimate).toBe(messageEstimate)

    context.setLedger(undefined)
    expect(context.state.ledger).toBeUndefined()
    expect(context.state.tokenEstimate).toBe(messageEstimate)

    context.setLedger({ current: [ledgerRecord("intent", "current_user_request", "say hello again", "current", 2)] })
    context.clearLedger()
    expect(context.state.ledger).toBeUndefined()
    expect(context.state.tokenEstimate).toBe(messageEstimate)
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
    context.add(toolCallMessage({ id: "call_logs", name: "bash", input: { command: "cat logs" } }))
    context.add(toolResultMessage({ callID: "call_logs", toolName: "bash", status: "succeeded", output: "x".repeat(28_000) }))

    const messages = context.compose()
    const providerInput = messages.map((message) => message.content).join("\n")
    const providerToolResult = messages.flatMap((message) => message.parts ?? []).find((part) => part.type === "tool_result")

    expect(context.state.tokenEstimate).toBeLessThan(4_000)
    expect(providerInput).toContain("[truncated")
    expect(providerInput).not.toContain("x".repeat(9_000))
    expect(providerToolResult).toMatchObject({ type: "tool_result", output: expect.stringContaining("[truncated") })
    expect(providerToolResult).not.toMatchObject({ output: expect.stringContaining("x".repeat(9_000)) })
  })
})

function ledgerRecord(kind: LedgerKind, subject: string, value: string, status: LedgerStatus, turn: number, input: { reason?: string; scope?: LedgerRecord["scope"] } = {}): LedgerRecord {
  return {
    id: `${kind}_${subject}_${turn}`.replace(/[^A-Za-z0-9_.-]/g, "_"),
    kind,
    subject,
    value,
    status,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    evidence: { source: "user", messageIndex: turn },
    createdAtTurn: turn,
    updatedAtTurn: turn,
  }
}
