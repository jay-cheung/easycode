import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AgentRunner, createRunner } from "../../src/agent"
import { ContextManager } from "../../src/context"
import { textMessage, toolResults } from "../../src/message"
import { defaultPermissionRules, PermissionService } from "../../src/permission"
import { FakeProvider } from "../../src/provider"
import { ProviderError, type Provider, type ProviderEvent } from "../../src/provider"
import type { LogEvent } from "../../src/logger"
import { SessionStore } from "../../src/session"
import { defaultSessionSettings } from "../../src/settings"
import { Sandbox, SandboxPathEscapeError } from "../../src/sandbox"
import type { RunUiEvent } from "../../src/ui/timeline"

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
    expect(events.some((event) => event.type === "data" && event.name === "tool_result -> context" && event.detail?.tool === "bash")).toBe(true)
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
    const metrics = events.find((event): event is Extract<RunUiEvent, { type: "provider_metrics" }> => event.type === "provider_metrics")?.metrics
    const doneIndex = events.findIndex((event) => event.type === "run_done")
    const metricsIndex = events.findIndex((event) => event.type === "provider_metrics")

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
    expect(providerMessageContents[0].some((content) => content.includes("Tool usage priority"))).toBe(true)
    expect(providerMessageContents[1].some((content) => content.includes("Tool usage priority"))).toBe(true)
    expect(providerMessageContents[0].some((content) => content.includes("Available tools:"))).toBe(false)
    expect(providerMessageContents[1].some((content) => content.includes("Available tools:"))).toBe(false)
    expect(providerMessageContents[1].some((content) => content.includes("Fix"))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("streams assistant text deltas", async () => {
    const root = await fixture()
    const chunks: string[] = []
    const result = await createRunner({ root, provider: "fake", mode: "plan", onTextDelta: (text) => chunks.push(text) }).run("Plan how to fix the failing test", "plan")
    expect(result.status).toBe("completed")
    expect(chunks.join("")).toBe(result.text)
    expect(chunks.length).toBeGreaterThan(0)
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
    expect(result.text).toContain("Stopped after maxSteps (8).")
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
          yield { type: "tool_call", call: { id: "call_1", name: "bash", input: { command: "cat /tmp/apix_baseline.json" } } }
          return
        }
        yield { type: "text_delta", text: "I will recover with a project-local report path." }
      },
    }
    const sandbox = {
      root,
      resolve: () => root,
      execute: async () => {
        throw new SandboxPathEscapeError("/tmp/apix_baseline.json", "/tmp/apix_baseline.json", root)
      },
    } as unknown as Sandbox
    const permission = new PermissionService(
      [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "sandbox_bypass", pattern: "*", action: "ask" },
      ],
      () => "reject",
    )

    const result = await new AgentRunner({ root, provider, context, sandbox, permission }).run("跑完整 APIx 评测并保留全量报告", "build")

    expect(result.status).toBe("completed")
    const current = context.state.ledger?.current ?? []
    expect(current).toContainEqual(expect.objectContaining({ kind: "failure", subject: "last_tool_failure", value: expect.stringContaining("bash denied PermissionRejectedError") }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "constraint", subject: "tool_failure_scope_rule", value: expect.stringContaining("not abandoning or silently shrinking scope") }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "intent", subject: "main_objective_still_active", value: "跑完整 APIx 评测并保留全量报告" }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "constraint", subject: "next_recovery_action", value: expect.stringContaining(".easycode/reports") }))
    expect(current).toContainEqual(expect.objectContaining({ kind: "constraint", subject: "next_recovery_action", value: expect.stringContaining("avoid /tmp and /dev/null") }))
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
        yield { type: "tool_call", call: { id: "call_sleep", name: "bash", input: { command: "sleep 5" } } }
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
    expect(events.some((event) => event.type === "tool_progress")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("plan-mode-readonly", async () => {
    const root = await fixture()
    const before = await Bun.file(path.join(root, "src", "add.ts")).text()
    const result = await createRunner({ root, provider: "fake", mode: "plan" }).run("readonly-violation", "plan")
    expect(result.status).toBe("completed")
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toBe(before)
    expect(toolResults(result.messages).some((part) => part.status === "denied")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("plan-exit-completes-run", async () => {
    const root = await fixture()
    const chunks: string[] = []
    const result = await createRunner({ root, provider: "fake", mode: "plan", onTextDelta: (text) => chunks.push(text) }).run("plan-exit", "plan")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["plan_exit"])
    expect(result.text).toContain("<proposed_plan>")
    expect(chunks.join("")).toContain("<proposed_plan>")
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a - b")
    await rm(root, { recursive: true, force: true })
  })

  test("direct-agent-runner-uses-plan-permissions-for-plan-exit", async () => {
    const root = await fixture()
    const result = await new AgentRunner({ root, provider: new FakeProvider() }).run("plan-exit", "plan")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["plan_exit"])
    expect(result.text).toContain("<proposed_plan>")
    await rm(root, { recursive: true, force: true })
  })

  test("accepted-plan-runs-build-even-if-requested-mode-stays-plan", async () => {
    const root = await fixture()
    const runner = createRunner({ root, provider: "fake", mode: "plan" })
    const plan = await runner.run("Plan how to fix the failing test", "plan")
    expect(plan.status).toBe("completed")
    expect(plan.text).toContain("<proposed_plan>")
    const result = await runner.run("执行吧", "plan")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "edit", "bash"])
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a + b")
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
    const permission = new PermissionService(defaultPermissionRules("build"))
    const runner = new AgentRunner({ root, provider: new FakeProvider(), permission })
    const pending = runner.run("Fix the failing test", "build")
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
    const runner = new AgentRunner({ root, provider: new FakeProvider(), context })
    await runner.run("Fix the failing test with a very long instruction ".repeat(20), "build")
    expect(context.state.summary).toBeDefined()
    await rm(root, { recursive: true, force: true })
  })

  test("context compaction asks provider for a summary", async () => {
    const root = await fixture()
    const context = new ContextManager({ maxTokens: 20, compactAt: 0.5 })
    const events: RunUiEvent[] = []
    let summaryPrompt = ""
    const provider: Provider = {
      name: "test-provider",
      async *stream(input): AsyncIterable<ProviderEvent> {
        if (input.prompt.includes("Summarize conversation")) {
          summaryPrompt = input.providerMessages[0]?.content ?? ""
          yield { type: "text_delta", text: "<summary>\nModel generated summary.\n</summary>" }
          return
        }
        yield { type: "text_delta", text: "Done." }
      },
    }
    const result = await new AgentRunner({ root, provider, context, onEvent: (event) => events.push(event) }).run("Fix the failing test with a very long instruction ".repeat(20), "build")
    expect(result.status).toBe("completed")
    expect(summaryPrompt).toContain("Your task is to create a detailed summary")
    expect(summaryPrompt).toContain("Conversation to summarize:")
    expect(context.state.summary).toBe("Model generated summary.")
    expect(events).toContainEqual(expect.objectContaining({ type: "context_compaction", status: "started" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "context_compaction", status: "completed", summaryChars: "Model generated summary.".length }))
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
    expect(context.state.latestActualInputTokens).toBe(45)

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
    const result = await new AgentRunner({ root, provider, context, logger: (event) => events.push(event) }).run("Fix the failing test with a very long instruction ".repeat(20), "build")
    expect(result.status).toBe("completed")
    expect(events.some((event) => event.type === "provider" && event.name === "provider.summary_request" && String(event.detail?.content).includes("Conversation to summarize:"))).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.summary_output" && event.detail?.summary === "<summary>\nLogged summary.\n</summary>")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("skill-progressive-loading", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nFull demo skill")
    const result = await createRunner({ root, provider: "fake", mode: "build", settings: { ...defaultSessionSettings("fake"), selectedSkills: ["demo"], pendingSkillLoads: ["demo"] } }).run("use skill demo", "build")
    expect(result.usedTools).toContain("skill")
    expect(toolResults(result.messages).some((part) => part.output.includes("Full demo skill"))).toBe(true)
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
})
