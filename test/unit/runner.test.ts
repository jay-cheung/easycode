import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentRunner } from "../../src/agent"
import { buildSubagentTaskPrompt } from "../../src/agent/runner/helpers"
import { prepareProviderTurnRequest } from "../../src/agent/runner/runner-turn-prep"
import { recordToolOutcome } from "../../src/agent/runner/tool-execution"
import { runValidatedProviderTurnLoop } from "../../src/agent/runner/validated-provider-turn"
import { textMessage } from "../../src/message"
import { createBuiltinRegistry } from "../../src/tool"
import { createProvider } from "../../src/provider"
import { PermissionService, defaultPermissionRules } from "../../src/permission"
import { ContextManager } from "../../src/context"
import type { ProviderTurnResult } from "../../src/agent/runner/provider-turn"
import type { Provider, ProviderEvent } from "../../src/provider"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-runner-"))
}

describe("agent runner ui events", () => {
  test("subagent task prompts are role-specific and reuse prior subagent results compactly", () => {
    const prompt = buildSubagentTaskPrompt({
      requestId: 1,
      role: "explorer",
      task: "Inspect src/add.ts",
      successCriteria: "Identify the exported function.",
      maxProviderCalls: 8,
    }, "current_plan_id=plan_1\n".repeat(80), "summary ".repeat(200), [
      JSON.stringify({ role: "reviewer", status: "succeeded", summary: "Previous reviewer found src/add.ts returns a - b." }),
    ])

    expect(prompt).toContain("Role Contract:")
    expect(prompt).toContain("Find facts quickly with read/search tools.")
    expect(prompt).toContain("Use at most 8 model turns")
    expect(prompt).toContain("Prior Subagent Conclusions In This Run:")
    expect(prompt).toContain("returns a - b")
    expect(prompt).toContain("[truncated]")
    expect(prompt).not.toContain("current_plan_id=plan_1\n".repeat(80))
  })

  test("subagent task prompts cap prior subagent conclusions to the most recent bounded subset", () => {
    const prompt = buildSubagentTaskPrompt({
      requestId: 2,
      role: "reviewer",
      task: "Review the latest bounded slice.",
      maxProviderCalls: 5,
    }, "", undefined, [
      "Result 1 " + "alpha ".repeat(80),
      "Result 2 " + "beta ".repeat(80),
      "Result 3 " + "gamma ".repeat(80),
      "Result 4 " + "delta ".repeat(80),
    ])

    expect(prompt).toContain("Prior Subagent Conclusions In This Run:")
    expect(prompt).not.toContain("Result 1")
    expect(prompt).toContain("Result 2")
    expect(prompt).toContain("Result 4")
    expect(prompt).toContain("[truncated]")
  })

  test("validated provider loop retries plan-gate violations without converting them into provider errors", async () => {
    let attempts = 0
    const invalidTurn: ProviderTurnResult = {
      text: "Here is a plain status update instead of a plan.",
      reasoningText: "",
      toolCalls: [],
      replayEvents: [],
    }

    const result = await runValidatedProviderTurnLoop({
      runProviderTurn: async () => {
        attempts += 1
        return invalidTurn
      },
      emitProviderTurn: () => {},
      updateActiveHypothesis: () => {},
      recordHypothesisViolation: () => {},
      hypothesisCorrectionMessage: () => "hypothesis correction",
      validateTurn: () => ({
        correction: "Planning mode hard gate:\n- Return a proposal plan.",
        failureText: "Planning mode hard gate failed.",
      }),
      evidenceRevision: 0,
    }, {
      agent: { kind: "build", name: "run", depth: 0, mode: "build", tools: "enabled", systemPrompt: "test" },
      prompt: "review the code",
      messages: [],
      providerMessages: [],
      tools: [],
    })

    expect(attempts).toBe(3)
    expect(result.failureText).toBeUndefined()
    expect(result.retryMessage).toContain("Planning mode hard gate")
    expect(result.validationFailureCount).toBe(3)
    expect(result.lastRejectedTurn).toEqual({
      text: "Here is a plain status update instead of a plan.",
      reasoningText: "",
      toolNames: [],
    })
    expect(result.toolCalls).toHaveLength(0)
  })

  test("validated provider loop accepts raw proposed plan text without forcing plan_exit", async () => {
    const result = await runValidatedProviderTurnLoop({
      runProviderTurn: async () => ({
        text: "<proposed_plan>\n# Plan\n- Inspect\n</proposed_plan>",
        reasoningText: "",
        toolCalls: [],
        replayEvents: [],
      }),
      emitProviderTurn: () => {},
      updateActiveHypothesis: () => {},
      recordHypothesisViolation: () => {},
      hypothesisCorrectionMessage: () => "hypothesis correction",
      validateTurn: (turn) => turn.text.includes("<proposed_plan>")
        ? undefined
        : { correction: "need plan", failureText: "failed" },
      evidenceRevision: 0,
    }, {
      agent: { kind: "build", name: "run", depth: 0, mode: "build", tools: "enabled", systemPrompt: "test" },
      prompt: "plan the work",
      messages: [],
      providerMessages: [],
      tools: [],
    })

    expect(result.retryMessage).toBeUndefined()
    expect(result.text).toContain("<proposed_plan>")
  })

  test("validated provider loop appends correction messages as system prompts", async () => {
    const observedMessages: Array<Array<{ role: string; content: string }>> = []
    await runValidatedProviderTurnLoop({
      runProviderTurn: async (input) => {
        observedMessages.push(input.providerMessages.map((message) => ({ role: message.role, content: message.content })))
        return {
          text: observedMessages.length >= 2 ? "<proposed_plan>\n# Plan\n- Fix\n</proposed_plan>" : "not a plan",
          reasoningText: "",
          toolCalls: [],
          replayEvents: [],
        }
      },
      emitProviderTurn: () => {},
      updateActiveHypothesis: () => {},
      recordHypothesisViolation: () => {},
      hypothesisCorrectionMessage: () => "hypothesis correction",
      validateTurn: (turn) => turn.text.includes("<proposed_plan>")
        ? undefined
        : { correction: "Return a proposed plan.", failureText: "Planning mode hard gate failed." },
      evidenceRevision: 0,
    }, {
      agent: { kind: "build", name: "run", depth: 0, mode: "build", tools: "enabled", systemPrompt: "test" },
      prompt: "plan the work",
      messages: [],
      providerMessages: [{ role: "user", content: "plan the work" }],
      tools: [],
    })

    expect(observedMessages).toHaveLength(2)
    expect(observedMessages[0]).toEqual([{ role: "user", content: "plan the work" }])
    expect(observedMessages[1]).toEqual([
      { role: "user", content: "plan the work" },
      { role: "system", content: "Return a proposed plan." },
    ])
  })

  test("runner surfaces retry messages and falls back after repeated plan-gate failures", async () => {
    const root = await tmpdir()
    try {
      const events: string[] = []
      let providerCalls = 0
      const provider: Provider = {
        name: "custom",
        capabilities: {
          apiStyle: "local",
          supportsImages: false,
          supportsThinking: false,
          supportsReasoningEffort: false,
          effortValues: [],
          supportsJsonObjectResponse: false,
          supportsMaxOutputTokens: false,
          promptCacheMode: "none",
        },
        async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
          providerCalls += 1
          yield { type: "text_delta", text: "status only, no plan" }
          yield { type: "done" }
        },
      }

      const runner = new AgentRunner({
        root,
        provider,
        registry: createBuiltinRegistry(),
        permission: PermissionService.autoApprove(defaultPermissionRules("build")),
        forcePlanning: true,
        onEvent: (event) => {
          if (event.type === "failure") events.push(event.text)
        },
      })

      const result = await runner.run("review 当前代码", "build")

      expect(providerCalls).toBe(3)
      expect(result.status).toBe("failed")
      expect(result.text).toContain("模型连续未按要求产出计划")
      expect(result.text).toContain("status only, no plan")
      expect(events.some((text) => text.includes("Planning mode hard gate"))).toBe(true)
      expect(events.at(-1)).toContain("模型连续未按要求产出计划")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runner injects a stronger review planning template for review prompts", async () => {
    const root = await tmpdir()
    try {
      const capturedSystemMessages: string[] = []
      const provider: Provider = {
        name: "custom",
        capabilities: {
          apiStyle: "local",
          supportsImages: false,
          supportsThinking: false,
          supportsReasoningEffort: false,
          effortValues: [],
          supportsJsonObjectResponse: false,
          supportsMaxOutputTokens: false,
          promptCacheMode: "none",
        },
        async *stream(input): AsyncGenerator<ProviderEvent, void, unknown> {
          capturedSystemMessages.push(...input.providerMessages.filter((message) => message.role === "system").map((message) => message.content))
          yield { type: "text_delta", text: "<proposed_plan>\n# Review Plan\n- Research\n</proposed_plan>" }
          yield { type: "done" }
        },
      }

      const runner = new AgentRunner({
        root,
        provider,
        registry: createBuiltinRegistry(),
        permission: PermissionService.autoApprove(defaultPermissionRules("build")),
        forcePlanning: true,
      })

      const result = await runner.run("review 当前代码", "build")

      expect(result.status).toBe("completed")
      expect(capturedSystemMessages.some((content) => content.includes("Review Planning Gate Template:"))).toBe(true)
      expect(capturedSystemMessages.some((content) => content.includes("Call plan_exit with a low-risk review plan once the review scope is clear."))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("planning mode allows bounded coordinator inspection before the plan hard gate", async () => {
    const root = await tmpdir()
    try {
      let providerCalls = 0
      const provider: Provider = {
        name: "custom",
        capabilities: {
          apiStyle: "local",
          supportsImages: false,
          supportsThinking: false,
          supportsReasoningEffort: false,
          effortValues: [],
          supportsJsonObjectResponse: false,
          supportsMaxOutputTokens: false,
          promptCacheMode: "none",
        },
        async *stream(input): AsyncGenerator<ProviderEvent, void, unknown> {
          providerCalls += 1
          const corrections = input.providerMessages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n")
          if (providerCalls === 1) {
            expect(corrections.includes("Coordinator delegation gate")).toBe(false)
            yield { type: "tool_call", call: { id: "call_read", name: "read", input: { filePath: "src/add.ts" } } }
            return
          }
          yield { type: "text_delta", text: "<proposed_plan>\n# Plan\n- Inspect src/add.ts\n</proposed_plan>" }
          yield { type: "done" }
        },
      }

      const runner = new AgentRunner({
        root,
        provider,
        registry: createBuiltinRegistry(),
        permission: PermissionService.autoApprove(defaultPermissionRules("build")),
        forcePlanning: true,
      })

      const result = await runner.run("review 当前代码", "build")

      expect(providerCalls).toBe(2)
      expect(result.status).toBe("completed")
      expect(result.usedTools).toEqual(["read"])
      expect(result.text).toContain("# Plan")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("active plan steps suppress the exploration checkpoint prompt", () => {
    const context = new ContextManager()
    context.add(textMessage("user", "Review the current changes"))
    const prepared = prepareProviderTurnRequest({
      context,
      step: 7,
      maxSteps: 10,
      agent: { kind: "build", name: "run", depth: 0, mode: "build", tools: "enabled", systemPrompt: "test" },
      instructions: [],
      skills: [],
      selectedSkills: [],
      pendingSkillLoads: [],
      tools: [],
      usedTools: ["git_diff", "read_lines"],
      activeHypothesisMessages: [],
      activePlanStepId: "step_5",
    })

    expect(prepared.providerMessages.some((message) => message.content.includes("Exploration checkpoint reached"))).toBe(false)
  })

  test("emits immediate provider wait state after a tool result before the next model output", async () => {
    const root = await tmpdir()
    try {
      const skillDir = path.join(root, ".easycode", "skills", "demo")
      await mkdir(skillDir, { recursive: true })
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nDemo content")

      const events: string[] = []
      const runner = new AgentRunner({
        root,
        provider: createProvider("fake"),
        registry: createBuiltinRegistry(),
        permission: PermissionService.autoApprove(defaultPermissionRules("build")),
        onEvent: (event) => {
          if (event.type === "tool_result") events.push(`tool_result:${event.toolName}`)
          if (event.type === "provider_progress") events.push(`provider_progress:${event.elapsedMs}`)
          if (event.type === "text_delta") events.push(`text_delta:${event.text}`)
        },
      })

      const result = await runner.run("skill", "build")

      expect(result.status).toBe("completed")
      const toolResultIndex = events.indexOf("tool_result:skill")
      expect(toolResultIndex).toBeGreaterThan(-1)
      expect(events[toolResultIndex + 1]).toBe("provider_progress:0")
      expect(events.slice(toolResultIndex + 2)).toContain("text_delta:Skill loaded.")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("selected skills and pending loads are recorded in the ledger for compaction continuity", async () => {
    const root = await tmpdir()
    try {
      const skillDir = path.join(root, ".easycode", "skills", "demo")
      await mkdir(skillDir, { recursive: true })
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nDemo content")

      const runner = new AgentRunner({
        root,
        provider: createProvider("fake"),
        registry: createBuiltinRegistry(),
        permission: PermissionService.autoApprove(defaultPermissionRules("build")),
        settings: {
          provider: "fake",
          language: "en",
          thinking: true,
          effort: "high",
          selectedSkills: ["demo"],
          pendingSkillLoads: ["demo"],
          maxTokens: 32_000,
          maxSteps: 66,
        },
      })

      await runner.run("skill", "build")
      const current = runner.context.state.ledger?.current ?? []
      expect(current).toContainEqual(expect.objectContaining({ subject: "active_skills", value: "demo" }))
      expect(current).toContainEqual(expect.objectContaining({ subject: "pending_skill_loads", value: "none" }))
      expect(current).toContainEqual(expect.objectContaining({ subject: "active_capability_surface", value: expect.stringContaining("skills=demo") }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("successful retrieval tools update the active capability ledger state", () => {
    const context = new ContextManager()
    context.updateLedger({
      current: [
        {
          id: "skills",
          kind: "checkpoint",
          subject: "active_skills",
          value: "demo",
          status: "current",
          createdAtTurn: 1,
          updatedAtTurn: 1,
          evidence: { source: "assistant" },
        },
      ],
    })

    recordToolOutcome(
      { context },
      { id: "call_mcp", name: "mcp_read_resource", input: { server: "local-docs", uri: "doc://agent/retrieval" } },
      { title: "Retrieval design", output: "ok", metadata: { status: "succeeded", source: { id: "local-docs:doc://agent/retrieval" } } },
      "inspect retrieval design",
      { truncateForLedger: (text) => text, compactLine: (text) => text },
    )
    recordToolOutcome(
      { context },
      { id: "call_connector", name: "connector_call", input: { name: "docs" } },
      { title: "docs", output: "ok", metadata: { status: "succeeded", connector: "docs" } },
      "inspect docs",
      { truncateForLedger: (text) => text, compactLine: (text) => text },
    )
    recordToolOutcome(
      { context },
      { id: "call_web", name: "web_search", input: { query: "prompt caching" } },
      { title: "prompt caching", output: "ok", metadata: { status: "succeeded", engine: "tavily" } },
      "inspect web evidence",
      { truncateForLedger: (text) => text, compactLine: (text) => text },
    )

    const current = context.state.ledger?.current ?? []
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_mcp_servers", value: "local-docs" }))
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_mcp_resources", value: "doc://agent/retrieval" }))
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_connectors", value: "docs" }))
    expect(current).toContainEqual(expect.objectContaining({ subject: "active_web_search_engine", value: "tavily" }))
    expect(current).toContainEqual(expect.objectContaining({
      subject: "active_capability_surface",
      value: expect.stringContaining("mcp_servers=local-docs"),
    }))
    expect(current).toContainEqual(expect.objectContaining({
      subject: "active_capability_surface",
      value: expect.stringContaining("web_search=tavily"),
    }))
  })
})
