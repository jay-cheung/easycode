import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AgentRunner, createRunner } from "../../src/agent"
import { PlanTracker } from "../../src/agent/planner"
import { maxSubagentInvocationsPerRun, roleInvocationLimit } from "../../src/agent/subagent-runtime"
import { ContextManager, estimateTextTokens } from "../../src/context"
import { textMessage, toolResults } from "../../src/message"
import { defaultPermissionRules, PermissionService } from "../../src/permission"
import { FakeProvider } from "../../src/provider"
import { ProviderError, type Provider, type ProviderEvent } from "../../src/provider"
import { createLogger, type LogEvent } from "../../src/logger"
import { ProjectMemoryStore } from "../../src/memory"
import { intermediatePlanStepReportMaxChars, intermediatePlanStepReportMaxLines, loadStructuredPlanState } from "../../src/plans"
import { SessionStore } from "../../src/session"
import { defaultSessionSettings } from "../../src/settings"
import { Sandbox, SandboxPathEscapeError } from "../../src/sandbox"
import type { RunUiEvent } from "../../src/ui/timeline"
import { ledgerRecord } from "../../src/agent/ledger"
import { createGoalState, goalStateFromContext, writeGoalState } from "../../src/goal"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "easycode-agent-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await Bun.write(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
  await Bun.write(path.join(root, ".env"), "SECRET=x\n")
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "bun test" } }))
  await mkdir(path.join(root, "test"), { recursive: true })
  await Bun.write(path.join(root, "test", "add.test.ts"), "import { expect, test } from 'bun:test'\nimport { add } from '../src/add'\ntest('adds', () => expect(add(2, 3)).toBe(5))\n")
  return root
}

async function waitForPendingPermission(permission: PermissionService, timeoutMs = 1_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const request = [...permission.pending.values()][0]
    if (request) return request
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for permission request")
}

describe("agent integration", () => {
  afterEach(() => {
    FakeProvider.clearResponses()
  })

  test("build-simple-edit", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("Fix the failing test", "build")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "edit", "bash"])
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a + b")
    await rm(root, { recursive: true, force: true })
  })

  test("semantic navigation uses repo map and line slices without full-file read", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("Use semantic navigation to inspect add", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["repo_map", "read_lines"])
    expect(await Bun.file(path.join(root, ".easycode", "cache", "repo-map.json")).exists()).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("semantic navigation can inspect call graph before reading focused lines", async () => {
    const root = await fixture()
    await Bun.write(path.join(root, "src", "leaf.ts"), "export function leaf() {\n  return 1\n}\n")
    await Bun.write(path.join(root, "src", "parent.ts"), "import { leaf } from './leaf'\nexport function parent() {\n  return leaf()\n}\n")
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => part.toolName)
        if (!results.includes("repo_map")) {
          yield { type: "tool_call", call: { id: "call_map", name: "repo_map", input: { dir: "src", language: "typescript", query: "leaf parent" } } }
          return
        }
        if (!results.includes("call_graph")) {
          yield { type: "tool_call", call: { id: "call_graph", name: "call_graph", input: { symbol: "leaf", direction: "callers", depth: 1, language: "typescript" } } }
          return
        }
        if (!results.includes("read_lines")) {
          yield { type: "tool_call", call: { id: "call_lines", name: "read_lines", input: { filePath: "src/parent.ts", startLine: 1, endLine: 4 } } }
          return
        }
        yield { type: "text_delta", text: "Call graph inspected." }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("Trace leaf callers", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["repo_map", "call_graph", "read_lines"])
    expect(toolResults(result.messages).find((part) => part.toolName === "call_graph")?.output).toContain("src/parent.ts#parent -> src/leaf.ts#leaf")
    await rm(root, { recursive: true, force: true })
  })

  test("prewarms repo map before the provider turn", async () => {
    const root = await fixture()
    let cacheExistedAtProvider = false
    const events: RunUiEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        cacheExistedAtProvider = await Bun.file(path.join(root, ".easycode", "cache", "repo-map.json")).exists()
        yield { type: "text_delta", text: "Done." }
      },
    }

    const result = await new AgentRunner({ root, provider, onEvent: (event) => events.push(event) }).run("Inspect current code", "build")

    expect(result.status).toBe("completed")
    expect(cacheExistedAtProvider).toBe(true)
    expect(events.some((event) => event.type === "repo_map" && event.status === "succeeded" && event.cachePath === ".easycode/cache/repo-map.json")).toBe(true)
    expect(result.messages.some((message) => message.parts.some((part) => part.type === "text" && part.text.includes("Done.")))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("auto recalls project memory for continuation-style prompts", async () => {
    const root = await fixture()
    await new ProjectMemoryStore(root).add({
      kind: "session_archive",
      text: "Previous payment retry investigation concluded that a stale retry flag caused duplicate retries.",
      tags: ["payment", "retry"],
      scope: { files: ["src/payment/retry.ts"], topics: ["payments"] },
    })
    let providerInput = ""
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        providerInput = input.providerMessages.map((message) => message.content).join("\n")
        yield { type: "text_delta", text: "Recalled." }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("继续处理 payment retry 的问题", "build")

    expect(result.status).toBe("completed")
    expect(providerInput).toContain("<project_memory_recall>")
    expect(providerInput).toContain("stale retry flag")
    expect(result.messages.some((message) => message.role === "system" && message.parts.some((part) => part.type === "text" && part.text.includes("<project_memory_recall>")))).toBe(true)
    expect(result.messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text.includes("Recalled.")))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("promotes durable workflow lessons through the runner", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (!toolResults(input.messages).some((part) => part.toolName === "memory_promote")) {
          yield {
            type: "tool_call",
            call: {
              id: "promote_memory",
              name: "memory_promote",
              input: {
                text: "After bounded slices, run focused tests before bun run gate.",
                kind: "successful_workflow",
                tags: ["workflow", "verification"],
                scope: { topics: ["verification"] },
              },
            },
          }
          return
        }
        yield { type: "text_delta", text: "Promotion completed." }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("promote workflow lesson into memory", "build")
    const records = await new ProjectMemoryStore(root).query("workflow verification", 5, { kinds: ["successful_workflow"] })

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["memory_promote"])
    expect(records).toEqual([
      expect.objectContaining({
        kind: "successful_workflow",
        text: "After bounded slices, run focused tests before bun run gate.",
        tags: ["workflow", "verification"],
      }),
    ])
    await rm(root, { recursive: true, force: true })
  })

  test("logger records data flow and state transitions", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const result = await createRunner({ root, provider: "fake", mode: "build", logger: (event) => events.push(event) }).run("Fix the failing test", "build")
    expect(result.status).toBe("completed")
    expect(events.some((event) => event.type === "state" && event.name === "agent.state" && event.detail?.from === "idle" && event.detail.to === "preparing")).toBe(true)
    expect(events.some((event) => event.type === "data" && event.name === "context -> provider")).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.input_tokens" && typeof event.detail?.tokenEstimate === "number")).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.tool_call" && event.detail?.tool === "read")).toBe(true)
    expect(events.some((event) => event.type === "tool" && event.name === "permission.evaluate" && event.detail?.tool === "edit")).toBe(true)
    expect(events.some((event) => event.type === "tool" && event.name === "permission.allowed" && event.detail?.tool === "edit" && event.detail?.source === "preapproved")).toBe(true)
    expect(events.some((event) => event.type === "data" && event.name === "tool_result -> context" && event.detail?.tool === "bash")).toBe(true)
    expect(events.some((event) => event.type === "data" && event.name === "provider -> tool_call_message" && event.detail?.tool === "bash" && typeof event.detail?.command === "string" && typeof event.detail?.commandClass === "string")).toBe(true)
    expect(events.some((event) => event.type === "data" && event.name === "tool_result -> context" && event.detail?.tool === "bash" && typeof event.detail?.command === "string" && typeof event.detail?.normalizedCommand === "string" && typeof event.detail?.commandClass === "string")).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.output" && typeof event.detail?.output === "string" && event.detail.output.length > 0)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("logger records actual provider prompt, output, and cached input marking", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "cached answer" }
        yield { type: "usage", inputTokens: 100, outputTokens: 10, cacheHitTokens: 60, cacheMissTokens: 40 }
      },
    }

    const result = await new AgentRunner({ root, provider, logger: (event) => events.push(event) }).run("Use cached context", "build")
    const inputEvent = events.find((event) => event.type === "provider" && event.name === "provider.input")
    const transcript = events.find((event) => event.type === "provider" && event.name === "provider.transcript")
    const usage = events.find((event) => event.type === "provider" && event.name === "provider.usage")

    expect(result.status).toBe("completed")
    expect(inputEvent?.detail?.prompt).toBe("Use cached context")
    expect(String(inputEvent?.detail?.input)).toContain("Use cached context")
    expect(transcript?.detail?.output).toBe("cached answer")
    expect(transcript?.detail?.cacheHit).toBe(true)
    expect(String(transcript?.detail?.markedInput)).toContain("<cached_input cache_hit=\"true\" tokens=\"60\">")
    expect(usage?.detail?.cacheHit).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("provider transcript output stays consistent with canonical assistant history", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "reasoning_delta", text: "r".repeat(3_000) }
        yield { type: "text_delta", text: "<proposed_plan>\n" + "step\n".repeat(1_500) + "</proposed_plan>" }
      },
    }

    const result = await new AgentRunner({ root, provider, logger: (event) => events.push(event) }).run("Return a very long plan", "build")
    const transcript = events.find((event) => event.type === "provider" && event.name === "provider.transcript")
    const lastAssistant = result.messages.at(-1)
    const assistantText = lastAssistant?.parts.find((part) => part.type === "text")

    expect(result.status).toBe("completed")
    expect(assistantText?.type).toBe("text")
    expect(String(transcript?.detail?.output)).toBe(assistantText?.type === "text" ? assistantText.text : "")
    expect(String(transcript?.detail?.output)).toContain("[truncated")
    await rm(root, { recursive: true, force: true })
  })

  test("emits provider metrics with APIx usage aggregation", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      model: "test-model",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "Done." }
        yield { type: "usage", inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20, totalTokens: 120, reasoningTokens: 5 }
      },
    }

    const result = await new AgentRunner({ root, provider, onEvent: (event) => events.push(event) }).run("Fix", "build")
    const metricsEvents = events.filter((e): e is Extract<RunUiEvent, { type: "provider_metrics" }> => e.type === "provider_metrics")
    expect(metricsEvents.length).toBeGreaterThanOrEqual(2)

    const interimMetrics = metricsEvents.filter(e => e.interim === true)
    expect(interimMetrics.length).toBeGreaterThanOrEqual(1)
    expect(interimMetrics[0].metrics.calls).toBe(1)
    expect(interimMetrics[0].metrics.inputTokens).toBe(0)

    const finalEvent = metricsEvents.find(e => !e.interim)
    expect(finalEvent).toBeDefined()
    const metrics = finalEvent!.metrics
    const doneIndex = events.findIndex((event) => event.type === "run_done")
    const metricsIndex = events.findIndex((event) => event.type === "provider_metrics" && !event.interim)

    expect(result.status).toBe("completed")
    expect(metricsIndex).toBeGreaterThanOrEqual(0)
    expect(doneIndex).toBeGreaterThan(metricsIndex)
    expect(metrics).toMatchObject({
      provider: "test-provider",
      model: "test-model",
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 80,
      cacheMissTokens: 20,
      totalTokens: 120,
      reasoningTokens: 5,
      hitRate: 0.8,
      effectiveCost: 61.6,
    })
    expect(metrics?.providerElapsedMs).toBeGreaterThanOrEqual(0)
    expect(metrics?.firstResponseMs).toBeGreaterThanOrEqual(0)
    await rm(root, { recursive: true, force: true })
  })

  test("does not emit subagent events when no compaction is needed", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    const result = await new AgentRunner({
      root,
      provider: new FakeProvider(),
      context: new ContextManager({ maxTokens: 64_000, compactAt: 0.9 }),
      onEvent: (event) => events.push(event),
    }).run("Fix the failing test", "build")

    expect(result.status).toBe("completed")
    expect(events.some((event) => event.type === "subagent")).toBe(false)
    expect(events.some((event) => event.type === "context_compaction")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("logger skips provider request body and successful responses", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "request", request: { url: "https://example.test", method: "POST", body: { input: "raw" } } }
        yield { type: "response", response: { url: "https://example.test", status: 200, ok: true, headers: { "content-type": "text/event-stream" } } }
        yield { type: "response_raw", response: { type: "response.output_text.delta", delta: "done" } }
        yield { type: "text_delta", text: "done" }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, logger: (event) => events.push(event) }).run("Fix", "build")
    expect(result.text).toBe("done")
    expect(events.some((event) => event.type === "provider" && event.name === "provider.request")).toBe(false)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.response" && event.detail?.status === 200)).toBe(false)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.response.raw" && event.detail?.response && JSON.stringify(event.detail.response) === "{\"type\":\"response.output_text.delta\",\"delta\":\"done\"}")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("logger records provider responses only on errors", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "request", request: { url: "https://example.test", method: "POST", body: { input: "raw" } } }
        yield { type: "response", response: { url: "https://example.test", status: 429, ok: false, headers: {}, body: "{\"error\":\"quota\"}" } }
        yield { type: "response_raw", response: { type: "response.failed", response: { error: { code: "quota", message: "quota exceeded" } } } }
        yield { type: "failure", error: { code: "quota", message: "quota exceeded", output: "{\"error\":\"quota\"}" } }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, logger: (event) => events.push(event) }).run("Fix", "build")
    expect(result.status).toBe("failed")
    expect(events.some((event) => event.type === "provider" && event.name === "provider.request")).toBe(false)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.response" && event.detail?.body === "{\"error\":\"quota\"}" && event.detail.status === undefined)).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.response.raw" && event.detail?.response)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("returns provider error output to the user", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        throw new ProviderError("quota exceeded", { status: 429, output: "{\"error\":{\"message\":\"quota exceeded\"}}" })
      },
    }
    const result = await new AgentRunner({ root, provider, logger: (event) => events.push(event) }).run("Fix", "build")
    expect(result.status).toBe("failed")
    expect(result.text).toContain("{\"error\":{\"message\":\"quota exceeded\"}}")
    expect(result.text).toContain("Run failed. Continue with another message")
    expect(result.messages.at(-1)?.role).toBe("assistant")
    expect(events.some((event) => event.type === "error" && event.name === "provider.error" && event.detail?.status === 429 && event.detail.output === "{\"error\":{\"message\":\"quota exceeded\"}}")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("fails gracefully and emits run_done when provider throws a generic connection error", async () => {
    const root = await fixture()
    const uiEvents: RunUiEvent[] = []
    const result = await new AgentRunner({
      root,
      provider: {
        name: "test-provider",
        async *stream(): AsyncIterable<ProviderEvent> {
          throw new Error("The socket connection was closed unexpectedly.")
        },
      },
      onEvent: (event) => uiEvents.push(event),
    }).run("Fix", "build")

    expect(result.status).toBe("failed")
    expect(result.text).toContain("The socket connection was closed unexpectedly.")
    expect(uiEvents).toContainEqual(expect.objectContaining({ type: "failure", source: "provider", category: "network" }))
    expect(uiEvents).toContainEqual(expect.objectContaining({ type: "run_done", status: "failed" }))
    await rm(root, { recursive: true, force: true })
  })

  test("active plans retry network provider failures once and preserve a recoverable pause", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const logs: LogEvent[] = []
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_provider_retry",
      title: "Retry provider network failure",
      lowRisk: true,
      steps: [
        {
          id: "step_1",
          goal: "Inspect src/add.ts",
          kind: "inspect",
          doneWhen: "The file has been inspected.",
        },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running" },
      status: "running",
    })

    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        throw new Error("The socket connection was closed unexpectedly.")
      },
    }

    const result = await new AgentRunner({ root, provider, context, logger: (event) => logs.push(event) }).run("Continue active plan after network issue", "build")

    expect(result.status).toBe("failed")
    expect(calls).toBe(2)
    expect(result.text).toContain("Network/provider failure persisted after one retry.")
    expect(result.text).toContain("checkpoint was preserved")
    expect(logs).toContainEqual(expect.objectContaining({ type: "provider", name: "provider.retry", detail: expect.objectContaining({ category: "network", attempt: 1, maxAttempts: 1 }) }))
    expect(logs).toContainEqual(expect.objectContaining({ type: "state", name: "goal.retryable_pause", detail: expect.objectContaining({ category: "network", hasActivePlan: true }) }))
    await rm(root, { recursive: true, force: true })
  })

  test("logs streamed provider failures as errors and output", async () => {
    const root = await fixture()
    const events: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "failure", error: { code: "insufficient_quota", message: "quota exceeded", output: "{\"code\":\"insufficient_quota\",\"message\":\"quota exceeded\"}" } }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, logger: (event) => events.push(event) }).run("Fix", "build")
    expect(result.status).toBe("failed")
    expect(result.text).toContain("{\"code\":\"insufficient_quota\",\"message\":\"quota exceeded\"}")
    expect(result.text).toContain("Run failed. Continue with another message")
    expect(events.some((event) => event.type === "provider" && event.name === "provider.failure" && event.detail?.code === "insufficient_quota")).toBe(true)
    expect(events.some((event) => event.type === "error" && event.name === "provider.error" && event.detail?.code === "insufficient_quota")).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.output" && event.detail?.output === "{\"code\":\"insufficient_quota\",\"message\":\"quota exceeded\"}")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("keeps assistant text before streamed provider failures", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "I checked the current state." }
        yield { type: "failure", error: { code: "quota", message: "quota exceeded", output: "quota exceeded" } }
      },
    }
    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Fix", "build")
    expect(result.status).toBe("failed")
    expect(result.text).toContain("I checked the current state.\nquota exceeded")
    expect(result.text).toContain("Run failed. Continue with another message")
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: result.text })
    await rm(root, { recursive: true, force: true })
  })

  test("outputs reasoning before assistant text", async () => {
    const root = await fixture()
    const chunks: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "reasoning_delta", text: "Need to inspect first." }
        yield { type: "text_delta", text: "Done." }
      },
    }
    const result = await new AgentRunner({ root, provider, onTextDelta: (text) => chunks.push(text) }).run("Fix", "build")
    expect(result.status).toBe("completed")
    expect(result.text).toBe("Done.")
    expect(result.reasoning).toBe("Need to inspect first.")
    expect(result.messages.at(-1)?.parts).toMatchObject([{ type: "reasoning", text: "Need to inspect first." }, { type: "text", text: "Done." }])
    expect(chunks.join("")).toBe("Need to inspect first.Done.")
    await rm(root, { recursive: true, force: true })
  })

  test("keeps streamed reasoning chunks contiguous within a provider turn", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "reasoning_delta", text: "The" }
        yield { type: "reasoning_delta", text: " user" }
        yield { type: "reasoning_delta", text: " is" }
        yield { type: "reasoning_delta", text: " asking" }
        yield { type: "text_delta", text: "Done." }
      },
    }
    const result = await new AgentRunner({ root, provider }).run("Fix", "build")
    expect(result.status).toBe("completed")
    expect(result.reasoning).toBe("The user is asking")
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "reasoning", text: "The user is asking" })
    await rm(root, { recursive: true, force: true })
  })

  test("accumulates reasoning across provider turns", async () => {
    const root = await fixture()
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: "reasoning_delta", text: "First thought." }
          yield { type: "tool_call", call: { id: "call_1", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        yield { type: "reasoning_delta", text: "Second thought." }
        yield { type: "text_delta", text: "Done." }
      },
    }
    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Fix", "build")
    expect(result.status).toBe("completed")
    expect(result.text).toBe("Done.")
    expect(result.reasoning).toBe("First thought.\nSecond thought.")
    await rm(root, { recursive: true, force: true })
  })

  test("retries a provider turn when hypotheses drift without new evidence", async () => {
    const root = await fixture()
    const chunks: string[] = []
    const context = new ContextManager()
    let calls = 0
    let correctionSeen = false
    let activeHypothesisSeen = false
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        calls += 1
        const systemPrompt = input.providerMessages.filter((message) => message.role === "system").map((message) => message.content).join("\n")
        correctionSeen ||= systemPrompt.includes("Hypothesis discipline violation detected.")
        activeHypothesisSeen ||= systemPrompt.includes("Active hypothesis: The bug is in src/add.ts.")
        if (calls === 1) {
          yield { type: "reasoning_delta", text: "The bug is in src/add.ts. Actually the bug is in test/add.test.ts." }
          yield { type: "tool_call", call: { id: "call_read_retry", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        if (calls === 2) {
          yield { type: "reasoning_delta", text: "The bug is in src/add.ts." }
          yield { type: "tool_call", call: { id: "call_read_ok", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }

    const result = await new AgentRunner({ root, provider, context, onTextDelta: (text) => chunks.push(text) }).run("Fix", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read"])
    expect(result.reasoning).toBe("The bug is in src/add.ts.")
    expect(result.reasoning).not.toContain("test/add.test.ts")
    expect(chunks.join("")).not.toContain("test/add.test.ts")
    expect(correctionSeen).toBe(true)
    expect(activeHypothesisSeen).toBe(true)
    expect(calls).toBe(3)
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "decision", subject: "active_hypothesis", value: "The bug is in src/add.ts." }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "failure", subject: "hypothesis_drift_violation" }))
    await rm(root, { recursive: true, force: true })
  })

  test("does not fail the run when repeated hypothesis drift remains unresolved", async () => {
    const root = await fixture()
    const chunks: string[] = []
    const context = new ContextManager()
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: "reasoning_delta", text: "The bug is in src/add.ts. Actually the bug is in test/add.test.ts." }
          yield { type: "tool_call", call: { id: "call_read_retry_1", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        if (calls === 2) {
          yield { type: "reasoning_delta", text: "The bug is in src/add.ts. Actually the bug is in test/add.test.ts." }
          yield { type: "tool_call", call: { id: "call_read_retry_2", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }

    const result = await new AgentRunner({ root, provider, context, onTextDelta: (text) => chunks.push(text) }).run("Fix", "build")

    expect(result.status).toBe("completed")
    expect(result.text).toBe("Done.")
    expect(result.usedTools).toEqual(["read"])
    expect(result.reasoning).toContain("test/add.test.ts")
    expect(result.text).not.toContain("Hypothesis drift blocked.")
    expect(chunks.join("")).not.toContain("Hypothesis drift blocked.")
    expect(calls).toBe(3)
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ kind: "failure", subject: "hypothesis_drift_violation" }))
    await rm(root, { recursive: true, force: true })
  })

  test("executes multiple tool calls from one provider turn in order", async () => {
    const root = await fixture()
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: "tool_call", call: { id: "call_read", name: "read", input: { filePath: "src/add.ts" } } }
          yield { type: "tool_call", call: { id: "call_list", name: "list", input: { dirPath: "src" } } }
          return
        }
        expect(input.messages.some((message) => message.role === "tool" && message.parts.some((part) => part.type === "tool_result" && part.callID === "call_read"))).toBe(true)
        expect(input.messages.some((message) => message.role === "tool" && message.parts.some((part) => part.type === "tool_result" && part.callID === "call_list"))).toBe(true)
        yield { type: "text_delta", text: "Done." }
      },
    }

    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Inspect files", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "list"])
    const assistantToolMessage = result.messages.find((message) => message.role === "assistant" && message.parts.some((part) => part.type === "tool_call" && part.call.id === "call_read"))
    expect(assistantToolMessage?.parts.filter((part) => part.type === "tool_call").map((part) => part.call.id)).toEqual(["call_read", "call_list"])
    expect(toolResults(result.messages).map((part) => part.callID)).toContain("call_read")
    expect(toolResults(result.messages).map((part) => part.callID)).toContain("call_list")
    await rm(root, { recursive: true, force: true })
  })

  test("continues later tool calls after an earlier tool failure in the same turn", async () => {
    const root = await fixture()
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: "tool_call", call: { id: "call_bad_read", name: "read", input: {} } }
          yield { type: "tool_call", call: { id: "call_list", name: "list", input: { dirPath: "src" } } }
          return
        }
        yield { type: "text_delta", text: "Recovered." }
      },
    }

    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Inspect files", "build")
    const results = toolResults(result.messages)

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "list"])
    expect(results.find((part) => part.callID === "call_bad_read")).toMatchObject({ status: "failed" })
    expect(results.find((part) => part.callID === "call_list")).toMatchObject({ status: "succeeded" })
    await rm(root, { recursive: true, force: true })
  })

  test("loads project instruction files into provider context by default", async () => {
    const root = await fixture()
    await Bun.write(path.join(root, "AGENTS.md"), "Use the local project rule.")
    const prompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        prompts.push(input.providerMessages.map((message) => message.content).join("\n\n"))
        yield { type: "text_delta", text: "Done." }
      },
    }

    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Check instructions", "build")

    expect(result.status).toBe("completed")
    expect(prompts[0]).toContain('<instruction source="project" path="AGENTS.md">')
    expect(prompts[0]).toContain("Use the local project rule.")
    await rm(root, { recursive: true, force: true })
  })

  test("loads multiple project instruction files before dynamic history", async () => {
    const root = await fixture()
    await Bun.write(path.join(root, "easycode.md"), "Project easycode rule.")
    await Bun.write(path.join(root, "AGENTS.md"), "Project agents rule.")
    await Bun.write(path.join(root, "CLAUDE.md"), "Project claude rule.")
    const prompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        prompts.push(input.providerMessages.map((message) => message.content).join("\n\n"))
        yield { type: "text_delta", text: "Done." }
      },
    }

    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Check instructions", "build")

    expect(result.status).toBe("completed")
    expect(prompts[0]).toContain('<instruction source="project" path="easycode.md">')
    expect(prompts[0]).toContain("Project easycode rule.")
    expect(prompts[0]).toContain('<instruction source="project" path="AGENTS.md">')
    expect(prompts[0]).toContain("Project agents rule.")
    expect(prompts[0]).toContain('<instruction source="project" path="CLAUDE.md">')
    expect(prompts[0]).toContain("Project claude rule.")
    expect(prompts[0].indexOf("Project claude rule.")).toBeLessThan(prompts[0].indexOf("Check instructions"))
    await rm(root, { recursive: true, force: true })
  })

  test("sends static composed context on every provider turn", async () => {
    const root = await fixture()
    const providerMessageContents: string[][] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        providerMessageContents.push(input.providerMessages.map((message) => message.content))
        if (providerMessageContents.length === 1) {
          yield { type: "tool_call", call: { id: "call_1", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }
    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Fix", "build")
    expect(result.status).toBe("completed")
    expect(providerMessageContents[0].some((content) => content.includes("Navigation and cache contract"))).toBe(true)
    expect(providerMessageContents[1].some((content) => content.includes("Navigation and cache contract"))).toBe(true)
    expect(providerMessageContents[0].some((content) => content.includes("Available tools:"))).toBe(false)
    expect(providerMessageContents[1].some((content) => content.includes("Available tools:"))).toBe(false)
    expect(providerMessageContents[1].some((content) => content.includes("Fix"))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("streams assistant text deltas", async () => {
    const root = await fixture()
    const chunks: string[] = []
    const result = await createRunner({ root, provider: "fake", mode: "build", onTextDelta: (text) => chunks.push(text) }).run("Fix the failing test", "build")
    expect(result.status).toBe("completed")
    expect(chunks.join("")).toBe(result.text)
    expect(chunks.length).toBeGreaterThan(0)
    await rm(root, { recursive: true, force: true })
  })

  test("asks for exploration direction after the summary checkpoint", async () => {
    const root = await fixture()
    const toolCounts: number[] = []
    const checkpointPrompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        toolCounts.push(input.tools.length)
        const checkpoint = input.providerMessages.map((message) => message.content).find((content) => content.includes("Exploration checkpoint reached"))
        if (checkpoint) {
          checkpointPrompts.push(checkpoint)
          yield { type: "text_delta", text: "I need one more area to be certain. Continue exploring, or summarize with the current evidence?" }
          yield { type: "done" }
          return
        }
        yield { type: "tool_call", call: { id: `call_${toolCounts.length}`, name: "read_lines", input: { filePath: "src/add.ts", startLine: 1, endLine: 3 } } }
        yield { type: "done" }
      },
    }

    const result = await new AgentRunner({ root, provider, maxSteps: 10 }).run("梳理当前代码结构", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toHaveLength(7)
    expect(toolCounts.slice(0, 7).every((count) => count > 0)).toBe(true)
    expect(toolCounts[7]).toBe(0)
    expect(checkpointPrompts[0]).toContain("Ask the user whether to continue exploring or summarize with the current evidence.")
    expect(result.text).toContain("Continue exploring")
    await rm(root, { recursive: true, force: true })
  })

  test("returns latest assistant text when max steps is reached", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "I inspected the issue and need one more command." }
        yield { type: "tool_call", call: { id: "call_1", name: "read", input: { path: "src/add.ts" } } }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, maxSteps: 1, onEvent: (event) => events.push(event) }).run("Fix", "build")
    expect(result.status).toBe("failed")
    expect(result.text).toContain("I inspected the issue and need one more command.")
    expect(result.text).toContain("Stopped after maxSteps (1).")
    expect(result.text).toContain("Continue with another message to keep going.")
    expect(events.some((event) => event.type === "failure" && event.text.includes("Continue with another message"))).toBe(true)
    expect(result.messages.at(-1)?.role).toBe("assistant")
    await rm(root, { recursive: true, force: true })
  })

  test("records the latest user request as the active objective", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "Done." }
      },
    }

    const result = await new AgentRunner({ root, provider, context }).run("全量跑 APIx，然后按报告格式输出结果", "build")

    expect(result.status).toBe("completed")
    const current = context.state.ledger?.current ?? []
    expect(current).toContainEqual(expect.objectContaining({ kind: "intent", subject: "current_user_request", value: "全量跑 APIx，然后按报告格式输出结果", status: "current" }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "constraint", subject: "main_objective", value: expect.stringContaining("complete latest request end-to-end") }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "constraint", subject: "failure_recovery_rule" }))
    await rm(root, { recursive: true, force: true })
  })

  test("keeps main objective after sandbox path-boundary tool failures", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (!input.messages.some((message) => message.role === "tool")) {
          yield { type: "tool_call", call: { id: "call_1", name: "bash", input: { command: "cat /var/apix_baseline.json" } } }
          return
        }
        yield { type: "text_delta", text: "I will recover with a project-local report path." }
      },
    }
    const sandbox = {
      root,
      resolve: () => root,
      execute: async () => {
        throw new SandboxPathEscapeError("/var/apix_baseline.json", "/var/apix_baseline.json", root)
      },
    } as unknown as Sandbox
    const permission = new PermissionService(
      [
        { permission: "bash", pattern: "*", action: "allow" },
      ],
      () => "reject",
    )

    const result = await new AgentRunner({ root, provider, context, sandbox, permission }).run("跑完整 APIx 评测并保留全量报告", "build")

    expect(result.status).toBe("completed")
    const current = context.state.ledger?.current ?? []
    expect(current).toContainEqual(expect.objectContaining({ kind: "failure", subject: "last_tool_failure", value: expect.stringContaining("bash failed path_boundary_blocked") }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "constraint", subject: "tool_failure_scope_rule", value: expect.stringContaining("not abandoning or silently shrinking scope") }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "intent", subject: "main_objective_still_active", value: "跑完整 APIx 评测并保留全量报告" }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "constraint", subject: "next_recovery_action", value: expect.stringContaining("allowed scratch paths like /tmp and /dev/null") }))
    await rm(root, { recursive: true, force: true })
  })

  test("emits elapsed progress for long-running bash tools", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: "tool_call", call: { id: "call_sleep", name: "bash", input: { command: "sleep 0.03" } } }
          yield { type: "done" }
          return
        }
        yield { type: "text_delta", text: "Done." }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, onEvent: (event) => events.push(event), toolProgressIntervalMs: 1 }).run("Run slow command", "build")
    expect(result.status).toBe("completed")
    expect(events.some((event) => event.type === "tool_progress" && event.toolName === "bash" && event.elapsedMs > 0)).toBe(true)
    expect(events.some((event) => event.type === "tool_result" && event.toolName === "bash" && typeof event.durationMs === "number" && event.durationMs > 0)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("emits provider wait progress before the first visible model event", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    const provider: Provider = {
      name: "slow-provider",
      model: "slow-model",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "request", request: { url: "https://example.test", method: "POST", body: {} } }
        await new Promise((resolve) => setTimeout(resolve, 20))
        yield { type: "text_delta", text: "Done." }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, onEvent: (event) => events.push(event), providerProgressIntervalMs: 1 }).run("Wait", "build")
    expect(result.status).toBe("completed")
    expect(events.some((event) => event.type === "run_start" && event.provider === "slow-provider")).toBe(true)
    expect(events.some((event) => event.type === "provider_progress" && event.provider === "slow-provider" && event.elapsedMs > 0)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("cancels a run while waiting for bash permission without reporting bash progress", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    const controller = new AbortController()
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "reasoning_delta", text: "loop reasoning ".repeat(500) }
        yield { type: "tool_call", call: { id: "call_sleep", name: "bash", input: { command: "sudo sleep 5" } } }
        yield { type: "done" }
      },
    }
    const permission = new PermissionService(defaultPermissionRules("build"), async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      return "reject" as const
    })

    const result = await new AgentRunner({ root, provider, permission, onEvent: (event) => events.push(event), toolProgressIntervalMs: 1 }).run("Run slow command", "build", { signal: controller.signal })

    expect(result.status).toBe("cancelled")
    expect(result.text).toContain("Run cancelled by user.")
    const lastMessage = result.messages.at(-1)
    const savedReasoning = lastMessage?.parts.find((part) => part.type === "reasoning")?.text ?? ""
    expect(savedReasoning.length).toBeLessThan(2_000)
    expect(savedReasoning).toContain("[truncated")
    expect(events.some((event) => event.type === "tool_progress")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("explicit plan mode surfaces a proposed plan without executing edits", async () => {
    const root = await fixture()
    const chunks: string[] = []
    const result = await createRunner({ root, provider: "fake", mode: "plan", onTextDelta: (text) => chunks.push(text) }).run("plan-exit", "plan")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["plan_exit"])
    expect(result.text).toContain("<proposed_plan>")
    expect(chunks.join("")).toContain("# Fake Plan")
    expect(chunks.join("")).not.toContain("<proposed_plan>")
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a - b")
    await rm(root, { recursive: true, force: true })
  })

  test("direct agent runner still allows explicit plan mode to return plan_exit", async () => {
    const root = await fixture()
    const result = await new AgentRunner({ root, provider: new FakeProvider() }).run("plan-exit", "plan")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["plan_exit"])
    expect(result.text).toContain("<proposed_plan>")
    await rm(root, { recursive: true, force: true })
  })

  test("legacy plan alias can still request a plan before continuing execution", async () => {
    const root = await fixture()
    const runner = createRunner({ root, provider: "fake", mode: "plan" })
    const plan = await runner.run("plan-exit", "plan")
    expect(plan.status).toBe("completed")
    expect(plan.text).toContain("<proposed_plan>")
    const result = await runner.run("执行吧", "plan")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "edit", "bash"])
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a + b")
    await rm(root, { recursive: true, force: true })
  })

  test("plan mode retries until the provider returns a proposed plan", async () => {
    const root = await fixture()
    const prompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        prompts.push(input.providerMessages.map((message) => String(message.content)).join("\n\n"))
        const hasToolResult = input.providerMessages.some(
          (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result")
        )
        if (hasToolResult) {
          yield { type: "text_delta", text: "Plan submitted." }
          return
        }
        const corrected = input.providerMessages.some(
          (message) => typeof message.content === "string" && message.content.includes("Planning mode hard gate:")
        )
        if (!corrected) {
          yield { type: "text_delta", text: "我先说一下当前状态，再给计划。" }
          return
        }
        yield { type: "tool_call", call: { id: "call_plan", name: "plan_exit", input: { markdown: "# Plan\n- Inspect the code.\n- Make the change." } } }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("给我一个计划", "plan")

    expect(result.status).toBe("completed")
    expect(result.text).toContain("<proposed_plan>")
    expect(prompts).toHaveLength(3)
    expect(prompts[1]).toContain("Planning mode hard gate:")
    await rm(root, { recursive: true, force: true })
  })

  test("plan mode allows bounded readonly exploration before plan_exit", async () => {
    const root = await fixture()
    const prompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        prompts.push(input.providerMessages.map((message) => String(message.content)).join("\n\n"))
        if (!toolResults(input.messages).some((part) => part.toolName === "read")) {
          yield { type: "tool_call", call: { id: "call_read", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        yield { type: "tool_call", call: { id: "call_plan", name: "plan_exit", input: { markdown: "# Plan\n- Fix the add implementation." } } }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("先读代码再给计划", "plan")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "plan_exit"])
    expect(result.text).toContain("<proposed_plan>")
    expect(prompts.join("\n")).not.toContain("Planning mode hard gate:")
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a - b")
    await rm(root, { recursive: true, force: true })
  })

  test("plan mode degrades to a fallback proposed plan when the provider refuses to return one", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "这是一段普通说明，不是计划。" }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("给我一个计划", "plan")

    expect(result.status).toBe("completed")
    expect(result.text).toContain("<proposed_plan>")
    expect(result.text).toContain("Fallback Execution Plan")
    await rm(root, { recursive: true, force: true })
  })

  test("running plans continue across steps without another user prompt", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const finalReport = [
      "Final verification report line 1: inspected src/add.ts and confirmed the initial diagnosis.",
      "Final verification report line 2: verified the bounded scope and preserved the expected plan ordering.",
      "Final verification report line 3: confirmed the completion contract is satisfied for the last step.",
      "Final verification report line 4: no additional follow-up plan is required for this synthetic run.",
      "Final verification report line 5: final deliverable is emitted directly from plan_step_complete.",
    ].join("\n")
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_auto_continue",
      title: "Auto Continue Plan",
      lowRisk: true,
      steps: [
        { id: "step_1", goal: "Inspect src/add.ts", kind: "inspect", doneWhen: "Inspection is complete." },
        { id: "step_2", goal: "Verify the result", kind: "verify", doneWhen: "Verification is complete." },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running", step_2: "pending" },
      status: "running",
    })

    let turnCount = 0
    const chunks: string[] = []
    const events: RunUiEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        turnCount += 1
        const completedSteps = toolResults(input.messages)
          .filter((part) => part.toolName === "plan_step_complete" && part.status === "succeeded")
          .length
        if (completedSteps === 0) {
          yield { type: "tool_call", call: { id: "call_complete_1", name: "plan_step_complete", input: { message: "inspection done", report: "Inspection completed for src/add.ts." } } }
          return
        }
        if (completedSteps === 1) {
          const latestToolResult = [...toolResults(input.messages)].reverse().find((part) => part.toolName === "plan_step_complete")
          expect(latestToolResult?.output).toContain("Continue immediately with that step")
          yield { type: "tool_call", call: { id: "call_complete_2", name: "plan_step_complete", input: { message: "verification done", report: finalReport } } }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider, context, onTextDelta: (text) => chunks.push(text), onEvent: (event) => events.push(event) }).run("Execute the approved plan", "build")

    expect(result.status).toBe("completed")
    expect(result.text).toContain("Final verification report line 5")
    expect(chunks.join("")).toContain("Final verification report line 5")
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.text).join("")).toContain("Final verification report line 5")
    expect(result.usedTools).toEqual(["plan_step_complete", "plan_step_complete"])
    expect(turnCount).toBe(2)
    await rm(root, { recursive: true, force: true })
  })

  test("goal-backed plans still return to the controller immediately after the final step", async () => {
    const root = await fixture()
    const context = new ContextManager()
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_goal_slice",
      title: "Goal Review Slice",
      lowRisk: true,
      steps: [
        { id: "step_1", goal: "Inspect src/add.ts", kind: "inspect", doneWhen: "Inspection is complete." },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running" },
      status: "running",
    })

    const goal = createGoalState("Finish the delegated review flow")
    writeGoalState(context, {
      ...goal,
      status: "executing",
      acceptanceCriteria: ["The completed slice returns control to goal review."],
      completionChecks: ["Review the finished slice before closing the goal."],
    })

    let turnCount = 0
    const chunks: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        turnCount += 1
        if (turnCount === 1) {
          yield { type: "tool_call", call: { id: "call_complete_1", name: "plan_step_complete", input: { message: "inspection done", report: "Goal slice inspection report." } } }
          return
        }
        yield { type: "text_delta", text: "This post-plan text should never be emitted while a goal slice is executing." }
      },
    }

    const result = await new AgentRunner({ root, provider, context, onTextDelta: (text) => chunks.push(text) }).run("Execute the approved goal plan", "build")

    expect(result.status).toBe("completed")
    expect(result.text).toContain("Goal slice inspection report.")
    expect(chunks.join("")).not.toContain("Goal slice inspection report.")
    expect(result.usedTools).toEqual(["plan_step_complete"])
    expect(turnCount).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  test("goal_complete exits immediately without a follow-up provider turn", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const goal = createGoalState("Finish the review")
    writeGoalState(context, {
      ...goal,
      status: "reviewing",
      acceptanceCriteria: ["The review has a final result."],
      completionChecks: ["The final result was verified."],
    })

    let turnCount = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        turnCount += 1
        if (turnCount === 1) {
          yield { type: "tool_call", call: { id: "call_goal_complete", name: "goal_complete", input: { summary: "Final goal summary." } } }
          return
        }
        throw new Error("goal_complete should have ended the run before another provider turn")
      },
    }

    const result = await new AgentRunner({ root, provider, context }).run("Assess the goal", "build")

    expect(result.status).toBe("completed")
    expect(result.text).toBe("Final goal summary.")
    expect(result.usedTools).toEqual(["goal_complete"])
    expect(turnCount).toBe(1)
    expect(goalStateFromContext(context)?.status).toBe("completed")
    await rm(root, { recursive: true, force: true })
  })

  test("plan_step_complete without a report is rejected by the validation gate", async () => {
    const root = await fixture()
    const context = new ContextManager()
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_report_required",
      title: "Report Required Plan",
      lowRisk: true,
      steps: [
        { id: "step_1", goal: "Inspect src/add.ts", kind: "inspect", doneWhen: "Inspection is complete." },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running" },
      status: "running",
    })

    let turnCount = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        turnCount += 1
        yield { type: "tool_call", call: { id: `call_complete_${turnCount}`, name: "plan_step_complete", input: { message: "inspection done" } } }
      },
    }

    const result = await new AgentRunner({ root, provider, context }).run("Execute the approved plan", "build")

    expect(result.status).toBe("completed")
    expect(turnCount).toBe(2)
    expect(result.text).toContain("Validation gate failed repeatedly")
    await rm(root, { recursive: true, force: true })
  })

  test("non-final plan_step_complete report is truncated instead of blocking the plan", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const overlongIntermediateReport = [
      "Intermediate report line 1: this is intentionally long enough to exceed the concise-report threshold for a non-final plan step.",
      "Intermediate report line 2: it keeps elaborating on details that should be reserved for the final user-facing deliverable.",
      "Intermediate report line 3: the validation gate should reject this before plan_step_complete can advance the plan.",
      "Intermediate report line 4: even more detail to ensure the report is clearly oversized for an intermediate step.",
      "Intermediate report line 5: this extra line locks the line-count rule as well as the character-count rule.",
    ].join("\n")
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_intermediate_report_limit",
      title: "Intermediate Report Limit",
      lowRisk: true,
      steps: [
        { id: "step_1", goal: "Inspect src/add.ts", kind: "inspect", doneWhen: "Inspection is complete." },
        { id: "step_2", goal: "Verify the result", kind: "verify", doneWhen: "Verification is complete." },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running", step_2: "pending" },
      status: "running",
    })

    let turnCount = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        turnCount += 1
        const completeCount = toolResults(input.messages)
          .filter((part) => part.toolName === "plan_step_complete" && part.status === "succeeded")
          .length
        if (completeCount === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "call_complete_final",
              name: "plan_step_complete",
              input: {
                message: "verification done",
                report: "Final verification report.",
              },
            },
          }
          return
        }
        yield {
          type: "tool_call",
          call: {
            id: `call_complete_${turnCount}`,
            name: "plan_step_complete",
            input: {
              message: "inspection done",
              report: overlongIntermediateReport,
            },
          },
        }
      },
    }

    const result = await new AgentRunner({ root, provider, context }).run("Execute the approved plan", "build")

    expect(result.status).toBe("completed")
    const completeResults = toolResults(result.messages).filter((part) => part.toolName === "plan_step_complete")
    expect(completeResults).toHaveLength(2)
    expect(completeResults[0]?.status).toBe("succeeded")
    expect(completeResults[0]?.metadata.reportTruncated).toBe(true)
    expect(String(completeResults[0]?.metadata.report).length).toBeLessThanOrEqual(intermediatePlanStepReportMaxChars)
    expect(String(completeResults[0]?.metadata.report).split(/\r?\n/).length).toBeLessThanOrEqual(intermediatePlanStepReportMaxLines)
    expect(completeResults[0]?.output).toContain("Report was truncated for this intermediate step")
    expect(result.text).toBe("Final verification report.")
    expect(turnCount).toBe(2)
    expect(result.usedTools).toEqual(["plan_step_complete", "plan_step_complete"])
    await rm(root, { recursive: true, force: true })
  })

  test("forced planning can activate a delegated inspect step and continue in the same session", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages)
        const delegateCount = results.filter((part) => part.toolName === "delegate_subagent" && part.status === "succeeded").length
        const completeCount = results.filter((part) => part.toolName === "plan_step_complete" && part.status === "succeeded").length
        if (input.prompt === "Start delegated slice") {
          yield {
            type: "tool_call",
            call: {
              id: "call_plan",
              name: "plan_exit",
              input: {
                markdown: [
                  "# Delegated slice",
                  "",
                  "```json",
                  JSON.stringify({
                    id: "plan_delegate_slice",
                    title: "Delegated slice",
                    lowRisk: true,
                    steps: [
                      {
                        id: "step_1",
                        goal: "Delegate explorer to inspect src/add.ts and report the incorrect operator",
                        kind: "inspect",
                        doneWhen: "The explorer has identified the exported function and the incorrect operator.",
                      },
                    ],
                  }, null, 2),
                  "```",
                ].join("\n"),
              },
            },
          }
          return
        }
        if (input.prompt === "Proceed with the approved plan.") {
          if (delegateCount === 0) {
            yield {
              type: "tool_call",
              call: {
                id: "call_delegate",
                name: "delegate_subagent",
                input: {
                  role: "explorer",
                  task: "Inspect src/add.ts",
                  success_criteria: "Identify the exported function and the incorrect operator.",
                },
              },
            }
            return
          }
          if (completeCount === 0) {
            yield { type: "tool_call", call: { id: "call_complete", name: "plan_step_complete", input: { message: "inspection complete", report: "Delegated slice final report." } } }
            return
          }
          return
        }
        if (input.prompt === "Inspect src/add.ts") {
          yield { type: "text_delta", text: "Found export function add in src/add.ts; it currently returns a - b." }
        }
      },
    }

    const runner = new AgentRunner({ root, provider, sessionId: "goal-delegate", forcePlanning: true })
    const planResult = await runner.run("Start delegated slice", "build")
    const stored = await loadStructuredPlanState(root, "goal-delegate", "plan_delegate_slice")
    const executeResult = await runner.run("Proceed with the approved plan.", "build")

    expect(planResult.status).toBe("completed")
    expect(planResult.text).toContain("<proposed_plan>")
    expect(stored?.plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "explorer" })
    expect(executeResult.status).toBe("completed")
    expect(executeResult.text).toContain("Delegated slice final report.")
    expect(executeResult.usedTools).toEqual(["delegate_subagent", "plan_step_complete"])
    expect(toolResults(executeResult.messages).some((part) =>
      part.toolName === "delegate_subagent" &&
      part.status === "succeeded" &&
      part.output.includes("returns a - b.")
    )).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("invalid structured plan output does not activate an executable plan", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Markdown Plan:")) {
          yield { type: "text_delta", text: "not-json" }
          return
        }
        yield { type: "tool_call", call: { id: "call_plan", name: "plan_exit", input: { markdown: "# Plan\n- Inspect the code.\n- Fix the issue." } } }
      },
    }

    const runner = new AgentRunner({ root, provider, sessionId: "invalid-plan" })
    const result = await runner.run("invalid-structured-plan", "build")

    expect(result.status).toBe("completed")
    expect(result.text).toContain("<proposed_plan>")
    expect(runner.context.state.ledger?.current.some((record) => record.subject === "current_plan_id")).toBe(false)
    expect(await loadStructuredPlanState(root, "invalid-plan", "plan_12345")).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  test("active plan status questions do not trigger a replan", async () => {
    const root = await fixture()
    const seenPrompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        seenPrompts.push(input.prompt)
        const corrected = input.providerMessages.some(
          (message) => typeof message.content === "string" && message.content.includes("Planning mode hard gate:")
        )
        if (input.prompt.includes("Markdown Plan:")) {
          yield {
            type: "text_delta",
            text: `\`\`\`json
{
  "id": "plan_status",
  "title": "Status Plan",
  "steps": [
    { "id": "step_1", "goal": "Inspect the code", "kind": "inspect", "doneWhen": "Inspection completed" },
    { "id": "step_2", "goal": "Edit the code", "kind": "edit", "doneWhen": "Edit completed" }
  ]
}
\`\`\``,
          }
          return
        }
        if (input.prompt === "创建计划") {
          yield { type: "tool_call", call: { id: "call_plan", name: "plan_exit", input: { markdown: "# Plan\n- Inspect the code.\n- Edit the code." } } }
          return
        }
        if (input.prompt === "现在到哪一步了？") {
          if (corrected) {
            yield { type: "tool_call", call: { id: "call_plan", name: "plan_exit", input: { markdown: "# Plan\n- step_1: Inspect the code.\n- step_2: Edit the code." } } }
            return
          }
          yield { type: "text_delta", text: "当前还在 step_1：Inspect the code。" }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }

    const runner = new AgentRunner({ root, provider, sessionId: "status-query" })
    await runner.run("创建计划", "build")
    const result = await runner.run("现在到哪一步了？", "build")

    expect(result.status).toBe("completed")
    expect(result.text).toContain("step_1")
    expect(result.text).toContain("<proposed_plan>")
    expect(seenPrompts).not.toContain("Replan request.")
    expect(runner.context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_plan_step", value: "step_1" }))
    await rm(root, { recursive: true, force: true })
  })

  test("explicit plan revision prompts trigger replanning", async () => {
    const root = await fixture()
    const seenPrompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        seenPrompts.push(input.prompt)
        if (input.prompt.includes("Markdown Plan:")) {
          yield {
            type: "text_delta",
            text: `\`\`\`json
{
  "id": "plan_revise",
  "title": "Original Plan",
  "steps": [
    { "id": "step_1", "goal": "Inspect the code", "kind": "inspect", "doneWhen": "Inspection completed" },
    { "id": "step_2", "goal": "Edit the code", "kind": "edit", "doneWhen": "Edit completed" }
  ]
}
\`\`\``,
          }
          return
        }
        if (input.prompt === "创建可重规划计划") {
          yield { type: "tool_call", call: { id: "call_plan", name: "plan_exit", input: { markdown: "# Plan\n- Inspect the code.\n- Edit the code." } } }
          return
        }
        if (input.prompt === "Replan request.") {
          yield {
            type: "text_delta",
            text: `\`\`\`json
{
  "id": "plan_revise",
  "title": "Revised Plan",
  "steps": [
    { "id": "step_1", "goal": "Inspect the code", "kind": "inspect", "doneWhen": "Inspection completed" },
    { "id": "step_2", "goal": "Add tests first", "kind": "verify", "doneWhen": "Tests added" },
    { "id": "step_3", "goal": "Edit the code", "kind": "edit", "doneWhen": "Edit completed" }
  ]
}
\`\`\``,
          }
          return
        }
        yield { type: "text_delta", text: "Replanned." }
      },
    }

    const runner = new AgentRunner({ root, provider, sessionId: "revise-plan" })
    await runner.run("创建可重规划计划", "build")
    const result = await runner.run("请重新规划，先补测试再改代码", "build")
    const state = await loadStructuredPlanState(root, "revise-plan", "plan_revise")

    expect(result.status).toBe("completed")
    expect(seenPrompts).toContain("Replan request.")
    expect(state?.plan.title).toBe("Revised Plan")
    expect(state?.plan.steps[1]?.goal).toBe("Add tests first")
    expect(state?.checkpoint.lastReplanReason).toBe("scope_change")
    await rm(root, { recursive: true, force: true })
  })

  test("permission-deny", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("delete tmp files", "build")
    expect(toolResults(result.messages).some((part) => part.output.includes("Permission denied"))).toBe(true)
    expect(toolResults(result.messages).some((part) => part.status === "denied")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("permission-ask-once", async () => {
    const root = await fixture()
    const call = (name: string, input: Record<string, unknown> = {}) => ({ id: `call_${name}`, name, input })
    const hasToolResult = (messages: any[], name: string) => toolResults(messages).some((part) => part.toolName === name)

    FakeProvider.registerResponse("Fix the failing test with custom rules", (input) => {
      const messages = input.messages
      const fileAlreadyRead = hasToolResult(messages, "read")
      if (!fileAlreadyRead) {
        return [
          { type: "tool_call" as const, call: call("read", { filePath: "src/add.ts" }) },
          { type: "done" as const }
        ]
      }
      const fileAlreadyEdited = hasToolResult(messages, "edit")
      if (!fileAlreadyEdited) {
        return [
          { type: "tool_call" as const, call: call("edit", { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=y" }) },
          { type: "done" as const }
        ]
      }
      const testsAlreadyRan = hasToolResult(messages, "bash")
      if (!testsAlreadyRan) {
        return [
          { type: "tool_call" as const, call: call("bash", { command: "chmod +x src/add.ts" }) },
          { type: "done" as const }
        ]
      }
      return [
        { type: "text_delta" as const, text: "Task completed." },
        { type: "done" as const }
      ]
    })

    const permission = new PermissionService(defaultPermissionRules("build"))
    const runner = new AgentRunner({ root, provider: new FakeProvider(), permission })
    const pending = runner.run("Fix the failing test with custom rules", "build")
    const request = await waitForPendingPermission(permission)
    expect(request.permission).toBe("edit")
    permission.reply(request.id, "once")
    const next = await waitForPendingPermission(permission)
    permission.reply(next.id, "once")
    const result = await pending
    expect(result.status).toBe("completed")
    await rm(root, { recursive: true, force: true })
  })

  test("context-compaction", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"history ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    const runner = new AgentRunner({ root, provider: new FakeProvider(), context })
    await runner.run("Fix the failing test", "build")
    await runner.waitForSummarySubagent()
    expect(context.state.summary).toBeDefined()
    await rm(root, { recursive: true, force: true })
  })

  test("context compaction asks provider for a summary", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    context.configureStrategy({ dynamicSummaryTokenBudget: 900 })
    context.setLedger({
      current: [ledgerRecord("decision", "active_hypothesis", "The bug is in src/add.ts.", "current", 1)],
    })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"history ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    const events: RunUiEvent[] = []
    let summaryPrompt = ""
    let summarySystemPrompt = ""
    let summaryMode = ""
    let summaryToolCount = -1
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          summarySystemPrompt = input.providerMessages.find((message) => message.role === "system")?.content ?? ""
          summaryPrompt = input.providerMessages.find((message) => message.content.includes("Conversation to summarize:"))?.content ?? ""
          summaryMode = input.mode
          summaryToolCount = input.tools.length
          yield { type: "text_delta", text: "<summary>\nModel generated summary.\n</summary>" }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }
    const runner = new AgentRunner({ root, provider, context, onEvent: (event) => events.push(event) })
    const result = await runner.run("修复失败测试", "build")
    await runner.waitForSummarySubagent()
    expect(result.status).toBe("completed")
    expect(summaryPrompt).toContain("Produce one durable working summary")
    expect(summaryPrompt).toContain("Keep the summary under approximately 900 tokens.")
    expect(summaryPrompt).toContain("Write the summary in Chinese.")
    expect(summaryPrompt).toContain("Preserve the current active hypothesis if it is still supported: The bug is in src/add.ts.")
    expect(summaryPrompt).toContain("Preserve the current user request exactly enough to continue without re-asking: 修复失败测试")
    expect(summaryPrompt).toContain("Keep a traceable direct user-input snippet for continuity: 修复失败测试")
    expect(summaryPrompt).toContain("Preserve the active capability surface if it is still relevant: skills=none; pending_skill_loads=none")
    expect(summaryPrompt).toContain("Conversation to summarize:")
    expect(summaryPrompt).toContain("Example output:")
    expect(summaryPrompt).not.toContain("wrap your analysis")
    expect(summarySystemPrompt).toContain("# Summary Agent - System Reminder")
    expect(summarySystemPrompt).toContain("direct user-input trace")
    expect(summaryMode).toBe("plan")
    expect(summaryToolCount).toBe(0)
    expect(context.state.summary).toBe("Model generated summary.")
    expect(events).toContainEqual(expect.objectContaining({
      type: "subagent",
      status: "scheduled",
      info: expect.objectContaining({
        role: "summary",
        provider: "test-provider",
        thinking: false,
        effort: undefined,
        maxProviderCalls: 2,
      }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: "subagent",
      status: "completed",
      info: expect.objectContaining({
        role: "summary",
        provider: "test-provider",
        thinking: false,
        effort: undefined,
        maxProviderCalls: 2,
      }),
      metrics: expect.objectContaining({
        source: "subagent",
        subagentRole: "summary",
        calls: 1,
      }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: "provider_metrics",
      metrics: expect.objectContaining({
        source: "subagent",
        subagentRole: "summary",
        calls: 1,
      }),
    }))
    expect(events).toContainEqual(expect.objectContaining({ type: "context_compaction", status: "started" }))
    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      status: "completed",
      summaryChars: "Model generated summary.".length,
      summaryTokens: estimateTextTokens("Model generated summary."),
    }))
    await rm(root, { recursive: true, force: true })
  })

  test("context compaction falls back locally when the summary provider fails", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"history ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    const events: RunUiEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          yield { type: "failure", error: { message: "summary provider unavailable", output: "connection refused" } }
          return
        }
        yield { type: "text_delta", text: "Done while summary fails." }
      },
    }

    const runner = new AgentRunner({ root, provider, context, onEvent: (event) => events.push(event) })
    const result = await runner.run("Fix the failing test", "build")
    await runner.waitForSummarySubagent()

    expect(result.status).toBe("completed")
    expect(context.state.summary).toContain("Fallback context summary generated locally")
    expect(context.state.summary).toContain("connection refused")
    expect(context.state.summary).toContain("old turn 0")
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent", status: "failed", error: expect.stringContaining("connection refused") }))
    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      status: "completed",
      error: expect.stringContaining("provider summary failed; used fallback"),
    }))
    await rm(root, { recursive: true, force: true })
  })

  test("context compaction summary subagent does not block the main provider turn", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"history ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    let releaseSummary = () => {}
    let markSummaryStarted = () => {}
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve
    })
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          markSummaryStarted()
          await new Promise<void>((resolve) => {
            releaseSummary = resolve
          })
          yield { type: "text_delta", text: "<summary>\nBackground summary.\n</summary>" }
          return
        }
        yield { type: "text_delta", text: "Done without waiting." }
      },
    }
    const runner = new AgentRunner({ root, provider, context })
    const resultPromise = runner.run("Fix the failing test", "build")
    await summaryStarted
    const result = await resultPromise
    expect(result.status).toBe("completed")
    expect(result.text).toBe("Done without waiting.")
    expect(context.state.summary).toBeUndefined()

    releaseSummary()
    await runner.waitForSummarySubagent()
    expect(context.state.summary).toBe("Background summary.")
    expect(JSON.stringify(context.state.messages)).toContain("Done without waiting.")
    await rm(root, { recursive: true, force: true })
  })

  test("context compaction still summarizes when the active window leaves no compacted messages", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    let summaryCalls = 0
    let summaryPrompt = ""
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          summaryCalls += 1
          summaryPrompt = input.providerMessages.find((message) => message.content.includes("Conversation to summarize:"))?.content ?? ""
          yield { type: "text_delta", text: "<summary>\nCurrent-window summary.\n</summary>" }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }

    const runner = new AgentRunner({ root, provider, context })
    const result = await runner.run(`Current-only request ${"long ".repeat(100)}`, "build")
    await runner.waitForSummarySubagent()

    expect(result.status).toBe("completed")
    expect(summaryCalls).toBe(1)
    expect(summaryPrompt).toContain("Conversation to summarize:")
    expect(context.state.summary).toBe("Current-window summary.")
    await rm(root, { recursive: true, force: true })
  })

  test("summary compaction is budgeted separately from foreground subagents", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"history ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          yield { type: "text_delta", text: "<summary>\nSeparate summary budget.\n</summary>" }
          return
        }
        yield { type: "text_delta", text: "Done with separate summary budget." }
      },
    }

    const runner = new AgentRunner({ root, provider, context, onEvent: (event) => events.push(event) })
    ;(runner as any).subagentUsage.byRole.summary = roleInvocationLimit("summary")
    ;(runner as any).subagentUsage.startedInvocations = maxSubagentInvocationsPerRun
    const result = await runner.run("Fix the failing test", "build")
    await runner.waitForSummarySubagent()

    expect(result.status).toBe("completed")
    expect(result.text).toBe("Done with separate summary budget.")
    expect(context.state.summary).toBe("Separate summary budget.")
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent", status: "scheduled", info: expect.objectContaining({ role: "summary" }) }))
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent", status: "completed", info: expect.objectContaining({ role: "summary" }) }))
    expect(events.some((event) => event.type === "subagent" && event.status === "failed" && event.info.role === "summary")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("summary compaction uses a derived subagent route for registered providers", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    context.configureStrategy({ dynamicSummaryTokenBudget: 900 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"history ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    const events: RunUiEvent[] = []
    const logs: LogEvent[] = []
    const provider = new FakeProvider({ model: "fake-main", thinking: true, effort: "max", maxOutputTokens: 8_192 })

    const runner = new AgentRunner({
      root,
      provider,
      context,
      logger: (event) => logs.push(event),
      onEvent: (event) => events.push(event),
    })
    const result = await runner.run("Fix the failing test", "build")
    await runner.waitForSummarySubagent()

    expect(result.status).toBe("completed")
    expect(context.state.summary).toBe("Fake compact summary.")
    expect(logs).toContainEqual(expect.objectContaining({
      type: "provider",
      name: "provider.subagent_route",
      detail: expect.objectContaining({
        role: "summary",
        provider: "fake",
        model: "fake-main",
        thinking: true,
        effort: "low",
        maxProviderCalls: 2,
        maxOutputTokens: 900,
      }),
    }))
    expect(logs).toContainEqual(expect.objectContaining({
      type: "provider",
      name: "provider.input",
      detail: expect.objectContaining({
        provider: "fake",
        model: "fake-main",
        thinking: true,
        effort: "low",
        maxOutputTokens: 900,
        prompt: "Summarize conversation for context compaction",
      }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: "subagent",
      status: "completed",
      metrics: expect.objectContaining({
        source: "subagent",
        subagentRole: "summary",
        thinking: true,
        effort: "low",
        maxOutputTokens: 900,
        maxProviderCalls: 2,
      }),
    }))
    await rm(root, { recursive: true, force: true })
  })

  test("delegate_subagent is intercepted by the runner and nested subagent calls are blocked", async () => {
    const root = await fixture()
    const logs: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "Use an explorer subagent") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "explorer", task: "Inspect src/add.ts", success_criteria: "Identify the exported function and file path." } } }
            return
          }
          yield { type: "text_delta", text: "Coordinator consumed the subagent result." }
          return
        }
        if (input.prompt === "Inspect src/add.ts") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_nested", name: "delegate_subagent", input: { role: "reviewer", task: "nested" } } }
            return
          }
          yield { type: "text_delta", text: "Found export function add in src/add.ts." }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider, logger: (event) => logs.push(event) }).run("Use an explorer subagent", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toContain("delegate_subagent")
    expect(toolResults(result.messages).some((part) => part.toolName === "delegate_subagent" && part.status === "succeeded" && part.output.includes("Found export function add"))).toBe(true)
    expect(logs).toContainEqual(expect.objectContaining({ type: "state", name: "subagent.nesting_blocked", detail: expect.objectContaining({ role: "explorer" }) }))
    await rm(root, { recursive: true, force: true })
  })

  test("delegate_subagent honors explicit timeout", async () => {
    const root = await fixture()
    try {
      let abortSeen = false
      const provider: Provider = {
        name: "timeout-provider",
        async *stream(input): AsyncIterable<ProviderEvent> {
          const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, status: part.status, metadata: part.metadata }))
          if (input.prompt === "Use timeout subagent") {
            if (!results.some((result) => result.tool === "delegate_subagent")) {
              yield { type: "tool_call", call: { id: "call_delegate_timeout", name: "delegate_subagent", input: { role: "explorer", task: "Wait until aborted", timeoutMs: 20 } } }
              return
            }
            yield { type: "text_delta", text: "Coordinator received timeout." }
            return
          }
          if (input.prompt === "Wait until aborted") {
            await new Promise<void>((_resolve, reject) => {
              const fallback = setTimeout(() => reject(new Error("timeout signal was not delivered")), 500)
              if (input.signal?.aborted) {
                abortSeen = true
                clearTimeout(fallback)
                reject(new Error("aborted by timeout"))
                return
              }
              input.signal?.addEventListener("abort", () => {
                abortSeen = true
                clearTimeout(fallback)
                reject(new Error("aborted by timeout"))
              }, { once: true })
            })
          }
        },
      }

      const result = await new AgentRunner({ root, provider }).run("Use timeout subagent", "build")
      const delegateResult = toolResults(result.messages).find((part) => part.toolName === "delegate_subagent")

      expect(result.status).toBe("completed")
      expect(abortSeen).toBe(true)
      expect(delegateResult?.metadata?.error).toBe("subagent_timeout")
      expect(delegateResult?.metadata?.timeoutMs).toBe(20)
      expect(delegateResult?.output).toContain("Subagent timed out after 20ms")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("subagent results stay coordinator-facing and emit role usage summaries", async () => {
    const root = await fixture()
    const logs: LogEvent[] = []
    const provider: Provider = {
      name: "metrics-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "Use an explorer subagent with evidence") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "explorer", task: "Read src/add.ts with evidence", success_criteria: "Identify the exported function." } } }
            return
          }
          yield { type: "text_delta", text: "Coordinator consumed summarized evidence." }
          return
        }
        if (input.prompt === "Read src/add.ts with evidence") {
          if (!results.some((result) => result.tool === "read_lines")) {
            yield { type: "tool_call", call: { id: "call_read", name: "read_lines", input: { filePath: "src/add.ts", startLine: 1, endLine: 3 } } }
            yield { type: "usage", inputTokens: 100, outputTokens: 8, cacheHitTokens: 40, cacheMissTokens: 60 }
            return
          }
          yield { type: "text_delta", text: "Found export function add in src/add.ts." }
          yield { type: "usage", inputTokens: 120, outputTokens: 12, cacheHitTokens: 80, cacheMissTokens: 40 }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider, logger: (event) => logs.push(event) }).run("Use an explorer subagent with evidence", "build")
    const delegateResult = toolResults(result.messages).find((part) => part.toolName === "delegate_subagent")

    expect(result.status).toBe("completed")
    expect(delegateResult?.output).toContain('"evidenceRefs"')
    expect(delegateResult?.output).not.toContain("<tool_result")
    expect(logs).toContainEqual(expect.objectContaining({
      type: "state",
      name: "subagent.invocation_summary",
      detail: expect.objectContaining({
        role: "explorer",
        status: "succeeded",
        providerCalls: 2,
        tokens: expect.objectContaining({ inputTokens: 220, outputTokens: 20 }),
        cache: expect.objectContaining({ cacheHitTokens: 120, cacheMissTokens: 100 }),
      }),
    }))
    expect(logs).toContainEqual(expect.objectContaining({
      type: "state",
      name: "subagent.usage_summary",
      detail: expect.objectContaining({
        byRole: expect.objectContaining({
          explorer: expect.objectContaining({ started: 1, succeeded: 1, turnsUsed: 2 }),
        }),
      }),
    }))
    await rm(root, { recursive: true, force: true })
  })

  test("build mode can return a direct review synthesis without forced reviewer delegation", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "review-gated-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "依据 Code Complete 维度制定项目 review/修复/优化方案") {
          yield { type: "text_delta", text: "Code Complete 项目审查/修复/优化方案：P1 类型安全，P2 错误处理。" }
          return
        }
        if (input.prompt === "Review runner files by Code Complete complexity dimension") {
          yield { type: "text_delta", text: "Reviewer finding: runner complexity should be split by bounded responsibilities." }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("依据 Code Complete 维度制定项目 review/修复/优化方案", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual([])
    expect(result.text).toContain("Code Complete 项目审查/修复/优化方案")
    expect(toolResults(result.messages).some((part) => part.toolName === "delegate_subagent")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("build mode can use direct fact-finding tools without forced delegate_subagent retries", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "gated-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "Inspect add with delegation gate") {
          if (results.some((result) => result.tool === "find_definition")) {
            yield { type: "text_delta", text: "Coordinator inspected add directly through semantic tools." }
            return
          }
          yield { type: "tool_call", call: { id: "call_repo_map", name: "repo_map", input: { dir: "src", language: "typescript", query: "add export" } } }
          yield { type: "tool_call", call: { id: "call_find_definition", name: "find_definition", input: { symbol: "add", language: "typescript" } } }
          return
        }
        if (input.prompt === "Inspect src/add.ts") {
          yield { type: "text_delta", text: "Found export function add in src/add.ts." }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("Inspect add with delegation gate", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["repo_map", "find_definition"])
    expect(result.text).toContain("Coordinator inspected add directly through semantic tools.")
    expect(toolResults(result.messages).some((part) => part.toolName === "delegate_subagent")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("build mode allows a single fact-finding read without forcing delegate_subagent", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "gated-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        const correctionSeen = input.providerMessages.some((message) => typeof message.content === "string" && message.content.includes("Coordinator delegation gate"))
        if (input.prompt === "Inspect add with single read delegation gate") {
          if (results.some((result) => result.tool === "read")) {
            yield { type: "text_delta", text: "Coordinator inspected src/add.ts directly." }
            return
          }
          if (results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "text_delta", text: "Coordinator consumed the delegated single-read findings." }
            return
          }
          if (correctionSeen) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "explorer", task: "Inspect src/add.ts", success_criteria: "Identify the exported function and owning file." } } }
            return
          }
          yield { type: "tool_call", call: { id: "call_read", name: "read", input: { filePath: "src/add.ts" } } }
          return
        }
        if (input.prompt === "Inspect src/add.ts") {
          yield { type: "text_delta", text: "Found export function add in src/add.ts." }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("Inspect add with single read delegation gate", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read"])
    expect(toolResults(result.messages).some((part) => part.toolName === "read" && part.status === "succeeded")).toBe(true)
    expect(toolResults(result.messages).some((part) => part.toolName === "delegate_subagent")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("build mode does not fail closed on coordinator delegation suggestions without an active plan step", async () => {
    const root = await fixture()
    let providerTurns = 0
    const provider: Provider = {
      name: "gated-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        providerTurns += 1
        if (toolResults(input.messages).some((part) => part.toolName === "web_fetch")) {
          yield { type: "text_delta", text: "Coordinator kept the direct web fetch result." }
          return
        }
        if (input.prompt === "Ignore delegation gate for web fetch") {
          yield { type: "tool_call", call: { id: `call_fetch_${providerTurns}`, name: "web_fetch", input: { url: "https://example.com/data.json" } } }
        }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("Ignore delegation gate for web fetch", "build")

    expect(result.status).toBe("completed")
    expect(providerTurns).toBe(2)
    expect(result.text).toContain("Coordinator kept the direct web fetch result.")
    expect(result.usedTools).toContain("web_fetch")
    await rm(root, { recursive: true, force: true })
  })

  test("active main plan steps can fall back to direct coordinator tools after repeated delegation gate rejection", async () => {
    const root = await fixture()
    const context = new ContextManager()
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_main_step_delegation_bypass",
      title: "Inspect with main after delegation retry",
      lowRisk: true,
      steps: [
        {
          id: "step_1",
          goal: "Inspect src/add.ts from the coordinator",
          kind: "inspect",
          doneWhen: "The current implementation is identified.",
        },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running" },
      status: "running",
    })

    let providerTurns = 0
    const provider: Provider = {
      name: "gated-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        providerTurns += 1
        const results = toolResults(input.messages).map((part) => part.toolName)
        if (!results.includes("read_lines")) {
          yield { type: "tool_call", call: { id: `call_read_lines_${providerTurns}`, name: "read_lines", input: { filePath: "src/add.ts", startLine: 1, endLine: 3 } } }
          return
        }
        if (!results.includes("plan_step_complete")) {
          yield { type: "tool_call", call: { id: "call_step_complete", name: "plan_step_complete", input: { message: "Coordinator inspected src/add.ts directly.", report: "Coordinator inspected src/add.ts directly after delegation retry." } } }
        }
      },
    }

    const result = await new AgentRunner({ root, provider, context }).run("Inspect main plan step after delegation retry", "build")

    expect(result.status).toBe("completed")
    expect(providerTurns).toBe(4)
    expect(result.usedTools).toEqual(["read_lines", "plan_step_complete"])
    expect(result.text).toContain("Coordinator inspected src/add.ts directly after delegation retry.")
    expect(toolResults(result.messages).some((part) => part.toolName === "delegate_subagent")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("plan-step delegation gate does not block direct coordinator tools when the assigned subagent role is exhausted", async () => {
    const root = await fixture()
    const context = new ContextManager()
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_exhausted_explorer",
      title: "Inspect despite exhausted explorer budget",
      lowRisk: true,
      steps: [
        {
          id: "step_1",
          goal: "Inspect src/add.ts with an explorer subagent",
          kind: "inspect",
          executorHint: "subagent",
          subagentRole: "explorer",
          doneWhen: "The current implementation is identified.",
        },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running" },
      status: "running",
    })

    let runner: AgentRunner
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "Inspect even if explorer is exhausted") {
          ;(runner as any).subagentUsage.byRole.explorer = roleInvocationLimit("explorer")
          if (!results.some((result) => result.tool === "read")) {
            yield { type: "tool_call", call: { id: "call_read", name: "read", input: { filePath: "src/add.ts" } } }
            return
          }
          if (!results.some((result) => result.tool === "plan_step_complete")) {
            yield { type: "tool_call", call: { id: "call_step_complete", name: "plan_step_complete", input: { message: "Coordinator inspected src/add.ts directly after explorer exhaustion.", report: "Coordinator inspected src/add.ts directly after explorer exhaustion." } } }
            return
          }
        }
      },
    }

    runner = new AgentRunner({ root, provider, context })
    const result = await runner.run("Inspect even if explorer is exhausted", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "plan_step_complete"])
    expect(result.text).toContain("Coordinator inspected src/add.ts directly after explorer exhaustion.")
    await rm(root, { recursive: true, force: true })
  })

  test("coordinator delegation gate does not force delegate_subagent when the suggested role is exhausted", async () => {
    const root = await fixture()
    let runner: AgentRunner
    const provider: Provider = {
      name: "gated-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "Inspect add when explorer is exhausted") {
          ;(runner as any).subagentUsage.byRole.explorer = roleInvocationLimit("explorer")
          if (!results.some((result) => result.tool === "read")) {
            yield { type: "tool_call", call: { id: "call_read", name: "read", input: { filePath: "src/add.ts" } } }
            return
          }
          yield { type: "text_delta", text: "Coordinator used direct inspection because explorer delegation was unavailable." }
        }
      },
    }

    runner = new AgentRunner({ root, provider })
    const result = await runner.run("Inspect add when explorer is exhausted", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read"])
    expect(toolResults(result.messages).some((part) => part.toolName === "delegate_subagent")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("coordinator receives the full delegate_subagent summary even when the raw result is truncated", async () => {
    const root = await fixture()
    const summary = "FULL_SUMMARY_" + "z".repeat(64)
    let providerSawFullSummary = false
    let providerSawTruncatedRawResult = false
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const resultSeen = toolResults(input.messages).some((part) => part.toolName === "delegate_subagent")
        if (input.prompt === "Use a large explorer result") {
          if (!resultSeen) {
            yield {
              type: "tool_call",
              call: {
                id: "call_delegate",
                name: "delegate_subagent",
                input: { role: "explorer", task: "Return a very large structured finding", success_criteria: "Return the full evidence summary." },
              },
            }
            return
          }
          const serializedMessages = input.providerMessages.map((message) => message.content).join("\n")
          providerSawFullSummary = serializedMessages.includes(summary) && serializedMessages.includes("<coordinator_summary>")
          providerSawTruncatedRawResult = serializedMessages.includes("[truncated")
          yield { type: "text_delta", text: providerSawFullSummary && providerSawTruncatedRawResult ? "Coordinator saw the full delegated summary." : "Coordinator missed the delegated summary." }
          return
        }
        if (input.prompt === "Return a very large structured finding") {
          yield { type: "text_delta", text: `${"subagent evidence ".repeat(500)}${summary}` }
        }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("Use a large explorer result", "build")

    expect(result.status).toBe("completed")
    expect(providerSawFullSummary).toBe(true)
    expect(providerSawTruncatedRawResult).toBe(true)
    expect(result.text).toContain("Coordinator saw the full delegated summary.")
    await rm(root, { recursive: true, force: true })
  })

  test("subagent logs and transcripts are written to separate files", async () => {
    const root = await fixture()
    const logger = createLogger({ root, session: "alpha" })
    const provider: Provider = {
      name: "test-provider",
      model: "main-model",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "Split the logs") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "docs_researcher", task: "Summarize src/add.ts", success_criteria: "Mention the exported function name." } } }
            return
          }
          yield { type: "text_delta", text: "Main run completed." }
          return
        }
        if (input.prompt === "Summarize src/add.ts") {
          yield { type: "text_delta", text: "The file exports add." }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider, logger, sessionId: "alpha" }).run("Split the logs", "build")

    expect(result.status).toBe("completed")
    const mainTranscript = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "alpha.txt")).text()
    const subagentTranscript = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "alpha.subagents.txt")).text()
    expect(mainTranscript).toContain("Turn 1")
    expect(mainTranscript).not.toContain("Subagent 1")
    expect(subagentTranscript).toContain("Subagent 1")
    expect(subagentTranscript).toContain("role=docs_researcher")
    expect(subagentTranscript).toContain("task=Summarize src/add.ts")
    await rm(root, { recursive: true, force: true })
  })

  test("command review uses the shared subagent logger and transcript", async () => {
    const root = await fixture()
    const logger = createLogger({ root, session: "command-review" })
    const command = "printf command-review-ok > /tmp/easycode-command-review.txt && cat /tmp/easycode-command-review.txt"
    const provider: Provider = {
      name: "test-provider",
      model: "main-model",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("hidden permission-review")) {
          yield { type: "text_delta", text: '{"decision":"allow_once","reason":"bounded scratch write"}' }
          return
        }
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (!results.some((result) => result.tool === "bash")) {
          yield { type: "tool_call", call: { id: "call_bash_review", name: "bash", input: { command } } }
          return
        }
        yield { type: "text_delta", text: "Reviewed command completed." }
      },
    }

    const result = await new AgentRunner({ root, provider, logger, sessionId: "command-review" }).run("Run reviewed bash", "build")

    expect(result.status).toBe("completed")
    expect(result.text).toContain("Reviewed command completed.")
    const mainTranscript = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "command-review.txt")).text()
    const subagentTranscript = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "command-review.subagents.txt")).text()
    const subagentLog = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "command-review.subagents.jsonl")).text()
    expect(mainTranscript).not.toContain("permission_reviewer")
    expect(subagentTranscript).toContain("role=permission_reviewer")
    expect(subagentTranscript).toContain("task=Review permission for bash")
    expect(subagentLog).toContain("\"name\":\"subagent.request\"")
    expect(subagentLog).toContain("\"role\":\"permission_reviewer\"")
    expect(subagentLog).toContain("\"name\":\"permission_review.decision\"")
    expect(subagentLog).toContain("\"name\":\"provider.transcript\"")
    await rm(root, { recursive: true, force: true })
  })

  test("debugger subagent rejects mutating bash and returns a bounded failure summary", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output, status: part.status }))
        if (input.prompt === "Use a debugger subagent to mutate the repo") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "debugger", task: "Attempt to touch a file in the repo and report what happens.", success_criteria: "Explain whether mutating bash is permitted." } } }
            return
          }
          const delegateResult = results.find((result) => result.tool === "delegate_subagent")
          expect(delegateResult?.status).toBe("succeeded")
          expect(delegateResult?.output).toContain("Mutating bash was blocked.")
          yield { type: "text_delta", text: "Coordinator observed the bounded debugger result." }
          return
        }
        if (input.prompt === "Attempt to touch a file in the repo and report what happens.") {
          const bashResult = results.find((result) => result.tool === "bash")
          if (!bashResult) {
            yield { type: "tool_call", call: { id: "call_bash", name: "bash", input: { command: "rm debug-side-effect.txt" } } }
            return
          }
          if (bashResult.status === "failed" || bashResult.status === "denied") {
            yield { type: "text_delta", text: "Mutating bash was blocked." }
            return
          }
          yield { type: "text_delta", text: "Mutating bash unexpectedly succeeded." }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("Use a debugger subagent to mutate the repo", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toContain("delegate_subagent")
    expect(toolResults(result.messages).some((part) => part.toolName === "delegate_subagent" && part.status === "succeeded" && part.output.includes("Mutating bash was blocked."))).toBe(true)
    expect(await Bun.file(path.join(root, "debug-side-effect.txt")).exists()).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("subagent stops repeated deterministic bash denials with structured handoff metadata", async () => {
    const root = await fixture()
    const logs: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output, status: part.status }))
        if (input.prompt === "Use a debugger subagent that repeats denied bash") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "debugger", task: "Try the same denied shell mutation twice and report blocker metadata.", success_criteria: "Return a handoff when bash remains denied." } } }
            return
          }
          const delegateResult = results.find((result) => result.tool === "delegate_subagent")
          expect(delegateResult?.status).toBe("succeeded")
          expect(delegateResult?.output).toContain('"status": "handoff"')
          expect(delegateResult?.output).toContain('"blockerClass": "permission_denied"')
          expect(delegateResult?.output).toContain('"retryable": false')
          yield { type: "text_delta", text: "Coordinator observed the debugger handoff." }
          return
        }
        if (input.prompt === "Try the same denied shell mutation twice and report blocker metadata.") {
          yield { type: "tool_call", call: { id: `call_bash_${results.length}`, name: "bash", input: { command: "rm debug-side-effect.txt" } } }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider, logger: (event) => logs.push(event) }).run("Use a debugger subagent that repeats denied bash", "build")

    expect(result.status).toBe("completed")
    const delegateTool = toolResults(result.messages).find((part) => part.toolName === "delegate_subagent")
    expect(delegateTool?.metadata?.subagentStatus).toBe("handoff")
    expect(delegateTool?.metadata?.blockerClass).toBe("permission_denied")
    expect(delegateTool?.metadata?.retryable).toBe(false)
    expect(delegateTool?.metadata?.recommendedNextRole).toBeUndefined()
    expect(logs).toContainEqual(expect.objectContaining({ type: "state", name: "subagent.failure_fuse", detail: expect.objectContaining({ role: "debugger", blockerClass: "permission_denied", retryable: false }) }))
    expect(await Bun.file(path.join(root, "debug-side-effect.txt")).exists()).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("delegate_subagent returns a stage handoff instead of failing when the turn budget is exhausted", async () => {
    const root = await fixture()
    const logs: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output, status: part.status }))
        if (input.prompt === "Use an explorer subagent with a bounded budget") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "explorer", task: "Inspect src/add.ts and gather evidence", success_criteria: "Prove what add exports and whether the implementation is correct." } } }
            return
          }
          const delegateResult = results.find((result) => result.tool === "delegate_subagent")
          expect(delegateResult?.status).toBe("succeeded")
          expect(delegateResult?.output).toContain('"status": "handoff"')
          yield { type: "text_delta", text: "Coordinator received the stage handoff." }
          return
        }
        if (input.prompt === "Inspect src/add.ts and gather evidence") {
          if (!results.some((result) => result.tool === "read_lines")) {
            yield { type: "tool_call", call: { id: "call_read_lines", name: "read_lines", input: { filePath: "src/add.ts", startLine: 1, endLine: 3 } } }
            return
          }
          yield { type: "tool_call", call: { id: "call_repo_map", name: "repo_map", input: { dir: "src", language: "typescript", query: "add" } } }
        }
      },
    }

    const result = await new AgentRunner({ root, provider, logger: (event) => logs.push(event) }).run("Use an explorer subagent with a bounded budget", "build")

    expect(result.status).toBe("completed")
    const delegateTool = toolResults(result.messages).find((part) => part.toolName === "delegate_subagent")
    expect(delegateTool).toBeDefined()
    expect(delegateTool?.status).toBe("succeeded")
    expect(delegateTool?.output).toContain('"status": "handoff"')
    expect(delegateTool?.output).toContain('"nextAction"')
    expect(logs).toContainEqual(expect.objectContaining({ type: "state", name: "subagent.result", detail: expect.objectContaining({ role: "explorer", status: "handoff" }) }))
    await rm(root, { recursive: true, force: true })
  })

  test("preferred assigned subagent steps can fall back to bounded coordinator reads after handoff", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const logs: LogEvent[] = []
    await Bun.write(path.join(root, "src", "large.ts"), Array.from({ length: 120 }, (_, index) => `export const value${index} = ${index}`).join("\n"))
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_preferred_explorer_fallback",
      title: "Inspect with preferred explorer fallback",
      lowRisk: true,
      steps: [
        {
          id: "step_1",
          goal: "Inspect src/add.ts with an explorer subagent",
          kind: "inspect",
          executorHint: "subagent",
          subagentRole: "explorer",
          delegationPolicy: "preferred",
          doneWhen: "The current implementation is identified.",
          fallback: "If explorer fails, manually inspect the source file and continue with available information.",
        },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running" },
      status: "running",
    })

    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages).map((part) => ({ tool: part.toolName, output: part.output }))
        if (input.prompt === "Inspect with preferred explorer fallback") {
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "explorer", task: "Inspect src/add.ts broadly", success_criteria: "Identify the current implementation." } } }
            return
          }
          if (!results.some((result) => result.tool === "read_lines")) {
            yield { type: "tool_call", call: { id: "call_read_lines", name: "read_lines", input: { filePath: "src/add.ts", startLine: 1, endLine: 3 } } }
            return
          }
          if (!results.some((result) => result.tool === "plan_step_complete")) {
            yield { type: "tool_call", call: { id: "call_step_complete", name: "plan_step_complete", input: { message: "Coordinator fallback completed.", report: "Coordinator fallback completed with read_lines evidence." } } }
          }
          return
        }
        if (input.prompt === "Inspect src/add.ts broadly") {
          yield { type: "tool_call", call: { id: `call_read_${results.length}`, name: "read", input: { filePath: "src/large.ts" } } }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider, context, logger: (event) => logs.push(event) }).run("Inspect with preferred explorer fallback", "build")
    const delegateTool = toolResults(result.messages).find((part) => part.toolName === "delegate_subagent")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["delegate_subagent", "read_lines", "plan_step_complete"])
    expect(delegateTool?.metadata?.subagentStatus).toBe("handoff")
    expect(delegateTool?.metadata?.blockerClass).toBe("large_output_or_read_blocked")
    expect(delegateTool?.metadata?.assignedStepId).toBe("step_1")
    expect(result.text).toContain("Coordinator fallback completed with read_lines evidence.")
    expect(logs).toContainEqual(expect.objectContaining({ type: "state", name: "plan.subagent_fallback_activated", detail: expect.objectContaining({ stepId: "step_1", role: "explorer", delegationPolicy: "preferred" }) }))
    await rm(root, { recursive: true, force: true })
  })

  test("delegate_subagent task packets include the active plan step assignment", async () => {
    const root = await fixture()
    const context = new ContextManager()
    await PlanTracker.activatePlan(context, root, "default", {
      id: "plan_subagent_task",
      title: "Inspect before edit",
      lowRisk: true,
      steps: [
        {
          id: "step_1",
          goal: "Inspect src/add.ts with an explorer subagent",
          kind: "inspect",
          executorHint: "subagent",
          subagentRole: "explorer",
          doneWhen: "The owner file and current implementation are identified.",
        },
      ],
    }, {
      currentStepId: "step_1",
      stepStatuses: { step_1: "running" },
      status: "running",
    })

    let subagentPrompt = ""
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt === "Delegate the active step") {
          const results = toolResults(input.messages).map((part) => ({ tool: part.toolName }))
          if (!results.some((result) => result.tool === "delegate_subagent")) {
            yield { type: "tool_call", call: { id: "call_delegate", name: "delegate_subagent", input: { role: "explorer", task: "Inspect src/add.ts", success_criteria: "Identify the owning file and implementation." } } }
            return
          }
          yield { type: "text_delta", text: "Coordinator consumed the assigned-step result." }
          return
        }
        if (input.prompt === "Inspect src/add.ts") {
          subagentPrompt = typeof input.providerMessages.at(-1)?.content === "string" ? input.providerMessages.at(-1)?.content as string : ""
          yield { type: "text_delta", text: "Inspection complete." }
          return
        }
      },
    }

    const result = await new AgentRunner({ root, provider, context }).run("Delegate the active step", "build")

    expect(result.status).toBe("completed")
    expect(subagentPrompt).toContain("Assigned Plan Step:")
    expect(subagentPrompt).toContain("step_1: Inspect src/add.ts with an explorer subagent")
    expect(subagentPrompt).toContain("Done When: The owner file and current implementation are identified.")
    await rm(root, { recursive: true, force: true })
  })

  test("plan_exit sanitizes hidden subagent executor metadata from user-visible plans", async () => {
    const root = await fixture()
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield {
          type: "tool_call",
          call: {
            id: "call_plan",
            name: "plan_exit",
            input: {
              markdown: [
                "# Hidden executor plan",
                "",
                "```json",
                JSON.stringify({
                  id: "plan_hidden",
                  title: "Hidden executor plan",
                  steps: [
                    {
                      id: "step_1",
                      goal: "Inspect the code",
                      kind: "inspect",
                      executorHint: "subagent",
                      subagentRole: "explorer",
                    },
                  ],
                }, null, 2),
                "```",
              ].join("\n"),
            },
          },
        }
      },
    }

    const result = await new AgentRunner({ root, provider }).run("Plan this task", "build")

    expect(result.status).toBe("completed")
    expect(result.text).not.toContain("executorHint")
    expect(result.text).not.toContain("subagentRole")
    expect(result.text).toContain("- **Low Risk**: true")
    expect(result.text).toContain('"lowRisk": true')
    const stored = await loadStructuredPlanState(root, "default", "plan_hidden")
    expect(stored?.plan.lowRisk).toBe(true)
    expect(stored?.plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "explorer" })
    await rm(root, { recursive: true, force: true })
  })

  test("compacted context saves summary and pruned history to session json", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 80, compactAt: 0.5, preserveRecentUserTurns: 2 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"历史内容 ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          yield { type: "text_delta", text: "<summary>\nModel generated summary.\n</summary>" }
          yield { type: "usage", inputTokens: 123, outputTokens: 12 }
          return
        }
        yield { type: "text_delta", text: "Done." }
        yield { type: "usage", inputTokens: 45, outputTokens: 6 }
      },
    }
    const result = await new AgentRunner({ root, provider, context }).run("current request", "build")
    expect(result.status).toBe("completed")
    expect(context.state.summary).toBe("Model generated summary.")
    expect(context.state.latestActualInputTokens).toBeUndefined()

    const store = new SessionStore(root)
    await store.save("demo", context)
    const saved = await store.load("demo")
    const savedJSON = JSON.stringify(saved)
    expect(saved?.summary).toBe("Model generated summary.")
    expect(savedJSON).not.toContain("old turn 0")
    expect(savedJSON).not.toContain("old turn 1")
    expect(savedJSON).not.toContain("old turn 2")
    expect(savedJSON).toContain("old turn 3")
    expect(savedJSON).toContain("current request")
    await rm(root, { recursive: true, force: true })
  })

  test("logger records summary request and output", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    for (let i = 0; i < 4; i += 1) {
      context.add(textMessage("user", `old turn ${i} ${"history ".repeat(20)}`))
      context.add(textMessage("assistant", `old reply ${i}`))
    }
    const events: LogEvent[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          yield { type: "text_delta", text: "<summary>\nLogged summary.\n</summary>" }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }
    const runner = new AgentRunner({ root, provider, context, logger: (event) => events.push(event) })
    const result = await runner.run("Fix the failing test", "build")
    await runner.waitForSummarySubagent()
    expect(result.status).toBe("completed")
    expect(events.some((event) => event.type === "provider" && event.name === "provider.summary_request" && String(event.detail?.content).includes("Conversation to summarize:"))).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.summary_output" && event.detail?.summary === "<summary>\nLogged summary.\n</summary>")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("skill-progressive-loading", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo", "scripts"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "scripts", "demo.sh"), "#!/usr/bin/env bash\n")
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nUse `scripts/demo.sh` first.\nFull demo skill")
    const result = await createRunner({ root, provider: "fake", mode: "build", settings: { ...defaultSessionSettings("fake"), selectedSkills: ["demo"], pendingSkillLoads: ["demo"] } }).run("use skill demo", "build")
    expect(result.usedTools).toContain("skill")
    expect(toolResults(result.messages).some((part) => part.output.includes("Loaded skill: demo"))).toBe(true)
    expect(toolResults(result.messages).some((part) => part.output.includes("scripts/demo.sh"))).toBe(true)
    expect(toolResults(result.messages).some((part) => part.output.includes("skill body omitted from persistent history"))).toBe(true)
    expect(toolResults(result.messages).every((part) => !part.output.includes("Full demo skill"))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("skill-progressive-loading auto-inspects referenced file artifacts before the next provider turn", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo", "scripts"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "scripts", "demo.sh"), "#!/usr/bin/env bash\necho demo\n")
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nUse `scripts/demo.sh` first.\nFull demo skill")
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages)
        if (!results.some((part) => part.toolName === "skill")) {
          yield { type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "demo" } } }
          return
        }
        expect(results.some((part) => part.toolName === "read" && part.output.includes("echo demo"))).toBe(true)
        yield { type: "text_delta", text: "Skill artifacts inspected." }
      },
    }

    const result = await new AgentRunner({ root, provider, settings: { ...defaultSessionSettings("test-provider"), selectedSkills: ["demo"], pendingSkillLoads: ["demo"] } }).run("use skill demo", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["skill", "read"])
    await rm(root, { recursive: true, force: true })
  })

  test("skill auto-inspection prioritizes concrete files before referenced directories", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo", "templates"), { recursive: true })
    await mkdir(path.join(root, ".easycode", "skills", "demo", "scripts"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "scripts", "demo.sh"), "#!/usr/bin/env bash\necho prioritized\n")
    await Bun.write(
      path.join(root, ".easycode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\nBrowse `templates/` for context.\nThen run `scripts/demo.sh`.\n",
    )
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages)
        if (!results.some((part) => part.toolName === "skill")) {
          yield { type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "demo" } } }
          return
        }
        const readIndex = results.findIndex((part) => part.toolName === "read" && part.output.includes("echo prioritized"))
        const listIndex = results.findIndex((part) => part.toolName === "list")
        expect(readIndex).toBeGreaterThan(-1)
        expect(listIndex).toBeGreaterThan(-1)
        expect(readIndex).toBeLessThan(listIndex)
        yield { type: "text_delta", text: "Prioritized file inspection." }
      },
    }

    const result = await new AgentRunner({ root, provider, settings: { ...defaultSessionSettings("test-provider"), selectedSkills: ["demo"], pendingSkillLoads: ["demo"] } }).run("use skill demo", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["skill", "read", "list"])
    await rm(root, { recursive: true, force: true })
  })

  test("skill auto-inspection skips low-signal file types while keeping scripts and template directories", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo", "templates"), { recursive: true })
    await mkdir(path.join(root, ".easycode", "skills", "demo", "scripts"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "scripts", "demo.sh"), "#!/usr/bin/env bash\necho kept\n")
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "image.png"), "not really a png")
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "archive.zip"), "not really a zip")
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await Bun.write(
      path.join(root, ".easycode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\nInspect `image.png` if needed.\nIgnore `archive.zip`.\nCheck `pnpm-lock.yaml` only if packaging breaks.\nRun `scripts/demo.sh`.\nBrowse `templates/`.\n",
    )
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const results = toolResults(input.messages)
        if (!results.some((part) => part.toolName === "skill")) {
          yield { type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "demo" } } }
          return
        }
        expect(results.some((part) => part.toolName === "read" && part.output.includes("echo kept"))).toBe(true)
        expect(results.some((part) => part.toolName === "list" && part.output.length >= 0)).toBe(true)
        expect(results.some((part) => part.toolName === "read" && part.output.includes("not really a png"))).toBe(false)
        expect(results.some((part) => part.toolName === "read" && part.output.includes("not really a zip"))).toBe(false)
        expect(results.some((part) => part.toolName === "read" && part.output.includes("lockfileVersion"))).toBe(false)
        yield { type: "text_delta", text: "Low-signal artifacts skipped." }
      },
    }

    const result = await new AgentRunner({ root, provider, settings: { ...defaultSessionSettings("test-provider"), selectedSkills: ["demo"], pendingSkillLoads: ["demo"] } }).run("use skill demo", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["skill", "read", "list"])
    await rm(root, { recursive: true, force: true })
  })

  test("pending selected skills load once", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nFull demo skill")
    const seenPrompts: string[] = []
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        const prompt = input.providerMessages.map((message) => message.content).join("\n")
        seenPrompts.push(prompt)
        if (prompt.includes("First-use skill load required")) {
          yield { type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "demo" } } }
          yield { type: "done" }
          return
        }
        yield { type: "text_delta", text: "Done." }
        yield { type: "done" }
      },
    }
    const settings = { ...defaultSessionSettings("test-provider"), selectedSkills: ["demo"], pendingSkillLoads: ["demo"] }
    const result = await new AgentRunner({ root, provider, settings }).run("handle the task", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["skill"])
    expect(settings.pendingSkillLoads).toEqual([])
    expect(seenPrompts[0]).toContain("First-use skill load required")
    expect(seenPrompts.at(-1)).not.toContain("First-use skill load required")
    await rm(root, { recursive: true, force: true })
  })

  test("sandbox-boundary", async () => {
    const root = await fixture()
    const runner = createRunner({ root, provider: "fake", mode: "build" })
    expect(() => runner.sandbox.resolve("../outside.txt")).toThrow()
    await rm(root, { recursive: true, force: true })
  })

  test("bash-timeout", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("timeout command", "build")
    expect(toolResults(result.messages).some((part) => part.metadata.timedOut === true)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
  test("extracts tool calls from text when provider returns XML instead of native tool_calls", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          // Simulate model outputting Anthropic-style XML tool calls in content instead of native tool_calls
          yield { type: "text_delta", text: 'Let me check the file.\n<tool_calls>\n<invoke name="read">\n<parameter name="filePath">src/add.ts</parameter>\n</invoke>\n</tool_calls>' }
          yield { type: "done" }
          return
        }
        yield { type: "text_delta", text: "Fixed." }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, onEvent: (event) => events.push(event), settings: defaultSessionSettings("test-provider") }).run("Fix the bug", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read"])
    expect(result.text).toBe("Fixed.")
    // Verify tool_call events were emitted for the extracted calls
    expect(events.some((event) => event.type === "tool_call" && event.call.name === "read")).toBe(true)
    // Verify tool_result events were emitted
    expect(events.some((event) => event.type === "tool_result" && event.toolName === "read" && event.status === "succeeded")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("extracts bare invoke XML tool calls from text fallback", async () => {
    const root = await fixture()
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: "text_delta", text: '<invoke name="list">\n<parameter name="dirPath">src</parameter>\n</invoke>' }
          yield { type: "done" }
          return
        }
        yield { type: "text_delta", text: "Listed." }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("List files", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["list"])
    await rm(root, { recursive: true, force: true })
  })

  test("extracts singular tool_call XML wrappers from text fallback without rendering raw wrapper text", async () => {
    const root = await fixture()
    const events: RunUiEvent[] = []
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield {
            type: "text_delta",
            text: 'Checking command.\n<tool_call>\n<invoke_name>bash</invoke_name>\n<args>\n<invoke>printf ok</invoke>\n</args>\n</tool_call>',
          }
          yield { type: "done" }
          return
        }
        yield { type: "text_delta", text: "Checked." }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, onEvent: (event) => events.push(event), settings: defaultSessionSettings("test-provider") }).run("Check command", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["bash"])
    expect(result.text).toBe("Checked.")
    expect(events.some((event) => event.type === "tool_call" && event.call.name === "bash")).toBe(true)
    expect(events.filter((event) => event.type === "text_delta").every((event) => !event.text.includes("<tool_call>") && !event.text.includes("<invoke_name>"))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("extracts DSML-style XML tool calls from text fallback", async () => {
    const root = await fixture()
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield {
            type: "text_delta",
            text: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="read">\n<｜｜DSML｜｜parameter name="filePath" string="true">src/add.ts</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
          }
          yield { type: "done" }
          return
        }
        yield { type: "text_delta", text: "Read completed." }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, settings: defaultSessionSettings("test-provider") }).run("Read file", "build")

    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read"])
    expect(result.text).toBe("Read completed.")
    await rm(root, { recursive: true, force: true })
  })

  test("extracts DSML edit calls without trimming string parameters or leaking markup", async () => {
    const root = await fixture()
    await Bun.write(
      path.join(root, "src", "slash.ts"),
      [
        "export function slashHelpText() {",
        "  return [",
        '    "  /skill list             list available skills",',
        '    "  /skill use <name>       keep a skill active for this session",',
        '    "  /skill clear            clear active skills",',
        "  ].join(\"\\n\")",
        "}",
        "",
      ].join("\n")
    )
    const events: RunUiEvent[] = []
    let calls = 0
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        calls += 1
        if (calls === 1) {
          yield {
            type: "text_delta",
            text: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="edit">\n<｜｜DSML｜｜parameter name="filePath" string="true">src/slash.ts</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="oldString" string="true">    "  /skill clear            clear active skills",</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="newString" string="true">    "  /skill remove <name>    remove one active skill",\n    "  /skill clear            clear active skills",</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
          }
          yield { type: "done" }
          return
        }
        yield { type: "text_delta", text: "Updated help text." }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, onEvent: (event) => events.push(event), settings: defaultSessionSettings("test-provider") }).run("Update slash help", "build")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["edit"])
    expect(result.text).toBe("Updated help text.")
    expect(await Bun.file(path.join(root, "src", "slash.ts")).text()).toContain('"  /skill remove <name>    remove one active skill"')
    expect(events.filter((event): event is Extract<RunUiEvent, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.text).join("")).not.toContain("DSML")
    await rm(root, { recursive: true, force: true })
  })
})
