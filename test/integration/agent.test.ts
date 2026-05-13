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

describe("agent integration", () => {
  test("build-simple-edit", async () => {
    const root = await fixture()
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("Fix the failing test", "build")
    expect(result.status).toBe("completed")
    expect(result.usedTools).toEqual(["read", "edit", "bash"])
    expect(await Bun.file(path.join(root, "src", "add.ts")).text()).toContain("return a + b")
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
    expect(result.text).toBe("{\"error\":{\"message\":\"quota exceeded\"}}")
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
    expect(result.text).toBe("{\"code\":\"insufficient_quota\",\"message\":\"quota exceeded\"}")
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
    const result = await new AgentRunner({ root, provider }).run("Fix", "build")
    expect(result.status).toBe("failed")
    expect(result.text).toBe("I checked the current state.\nquota exceeded")
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "I checked the current state.\nquota exceeded" })
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
    expect(result.text).toBe("<reasoning>\nNeed to inspect first.\n</reasoning>\nDone.")
    expect(chunks.join("")).toBe(result.text)
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
    const result = await new AgentRunner({ root, provider }).run("Fix", "build")
    expect(result.status).toBe("completed")
    expect(result.text).toBe("<reasoning>\nFirst thought.\nSecond thought.\n</reasoning>\nDone.")
    await rm(root, { recursive: true, force: true })
  })

  test("sends static composed context only on the first provider turn", async () => {
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
    const result = await new AgentRunner({ root, provider }).run("Fix", "build")
    expect(result.status).toBe("completed")
    expect(providerMessageContents[0].some((content) => content.includes("Available tools:"))).toBe(true)
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
    const provider: Provider = {
      name: "test-provider",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "I inspected the issue and need one more command." }
        yield { type: "tool_call", call: { id: "call_1", name: "read", input: { path: "src/add.ts" } } }
        yield { type: "done" }
      },
    }
    const result = await new AgentRunner({ root, provider, maxSteps: 1 }).run("Fix", "build")
    expect(result.status).toBe("failed")
    expect(result.text).toBe("I inspected the issue and need one more command.")
    expect(result.messages.at(-1)?.role).toBe("assistant")
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
    await new Promise((resolve) => setTimeout(resolve, 10))
    const request = [...permission.pending.values()][0]
    expect(request.permission).toBe("edit")
    permission.reply(request.id, "once")
    await new Promise((resolve) => setTimeout(resolve, 10))
    const next = [...permission.pending.values()][0]
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
    const result = await new AgentRunner({ root, provider, context }).run("Fix the failing test with a very long instruction ".repeat(20), "build")
    expect(result.status).toBe("completed")
    expect(summaryPrompt).toContain("Your task is to create a detailed summary")
    expect(summaryPrompt).toContain("Conversation to summarize:")
    expect(context.state.summary).toBe("Model generated summary.")
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
    const result = await createRunner({ root, provider: "fake", mode: "build" }).run("use skill demo", "build")
    expect(result.usedTools).toContain("skill")
    expect(toolResults(result.messages).some((part) => part.output.includes("Full demo skill"))).toBe(true)
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
