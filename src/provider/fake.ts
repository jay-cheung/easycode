import { Provider, ProviderInput, ProviderEvent } from "./types"
import { hasToolResult, call, latestToolResult } from "./utils"
import type { ProviderCapabilities, ProviderOptions } from "./types"

export class FakeProvider implements Provider {
  readonly name = "fake"
  readonly model?: string
  readonly capabilities: ProviderCapabilities = { apiStyle: "local", supportsImages: true, supportsThinking: true, supportsReasoningEffort: true, effortValues: ["low", "medium", "high", "max"], supportsJsonObjectResponse: true, supportsMaxOutputTokens: true, promptCacheMode: "reported", promptCacheMinPrefixTokens: numberFromEnv("FAKE_PROMPT_CACHE_MIN_PREFIX_TOKENS") }
  private readonly promptCounts = new Map<string, number>()

  constructor(options: ProviderOptions = {}) {
    this.model = options.model
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    const prompt = input.prompt.toLowerCase()
    if (prompt.includes("summarize conversation for context compaction")) {
      yield { type: "text_delta", text: "<summary>\nFake compact summary.\n</summary>" }
      yield { type: "done" }
      return
    }
    if (prompt.includes("loop")) {
      yield { type: "text_delta", text: "Still working." }
      yield { type: "tool_call", call: call("read", { filePath: "src/add.ts" }) }
      yield { type: "done" }
      return
    }
    if (prompt.includes("delayed")) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      yield { type: "text_delta", text: "Delayed done." }
      yield { type: "done" }
      return
    }
    if (prompt.includes("queued-ok")) {
      yield { type: "text_delta", text: "Queued done." }
      yield { type: "done" }
      return
    }
    if (prompt.includes("第五轮：输出最终状态")) {
      const seen = this.promptCounts.get(input.prompt) ?? 0
      this.promptCounts.set(input.prompt, seen + 1)
      yield { type: "text_delta", text: "{\"status\":\"ok\"}" }
      yield { type: "usage", inputTokens: 1000, outputTokens: 10, cacheHitTokens: seen > 0 ? 800 : 0, cacheMissTokens: seen > 0 ? 200 : 1000 }
      yield { type: "done" }
      return
    }
    if (prompt.includes("semantic navigation")) {
      if (!hasToolResult(input.messages, "repo_map")) {
        yield { type: "tool_call", call: call("repo_map", { dir: "src", language: "typescript" }) }
        yield { type: "done" }
        return
      }
      if (!hasToolResult(input.messages, "read_lines")) {
        yield { type: "tool_call", call: call("read_lines", { filePath: "src/add.ts", startLine: 1, endLine: 3 }) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: "Semantic navigation completed." }
      yield { type: "done" }
      return
    }
    if (input.mode === "plan") {
      const planExitAlreadyRan = hasToolResult(input.messages, "plan_exit")
      if (prompt.includes("plan-exit") && !planExitAlreadyRan) {
        yield { type: "tool_call", call: call("plan_exit", { markdown: "# Plan\n- Fix the failing test." }) }
        yield { type: "done" }
        return
      }
      const editAlreadyAttempted = hasToolResult(input.messages, "edit")
      if (prompt.includes("readonly-violation") && !editAlreadyAttempted) {
        yield { type: "tool_call", call: call("edit", { filePath: "src/add.ts", oldString: "-", newString: "+" }) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: `<proposed_plan>\n# Plan\n- Inspect the code.\n- Propose the smallest safe change.\n</proposed_plan>` }
      yield { type: "usage", inputTokens: 10, outputTokens: 20 }
      yield { type: "done" }
      return
    }
    if (prompt.includes("delete")) {
      const bashAlreadyRan = hasToolResult(input.messages, "bash")
      if (!bashAlreadyRan) {
        yield { type: "tool_call", call: call("bash", { command: "rm -rf tmp" }) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: "Permission denial handled." }
      yield { type: "done" }
      return
    }
    if (prompt.includes("env")) {
      const envReadAlreadyRan = hasToolResult(input.messages, "read")
      if (!envReadAlreadyRan) {
        yield { type: "tool_call", call: call("read", { filePath: ".env" }) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: "Environment read handled." }
      yield { type: "done" }
      return
    }
    if (prompt.includes("skill")) {
      const skillAlreadyLoaded = hasToolResult(input.messages, "skill")
      if (!skillAlreadyLoaded) {
        yield { type: "tool_call", call: call("skill", { name: "demo" }) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: "Skill loaded." }
      yield { type: "done" }
      return
    }
    if (input.providerMessages.some((message) => message.parts?.some((part) => part.type === "image"))) {
      yield { type: "reasoning_delta", text: "I should inspect the attached image." }
      yield { type: "text_delta", text: "Image received." }
      yield { type: "done" }
      return
    }
    if (prompt.includes("timeout")) {
      const bashAlreadyRan = hasToolResult(input.messages, "bash")
      if (!bashAlreadyRan) {
        yield { type: "tool_call", call: call("bash", { command: "sleep 5", timeoutMs: 50 }) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: "Timeout surfaced." }
      yield { type: "done" }
      return
    }
    if (prompt.includes("slow command")) {
      const bashAlreadyRan = hasToolResult(input.messages, "bash")
      if (!bashAlreadyRan) {
        yield { type: "tool_call", call: call("bash", { command: "sleep 5" }) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: "Slow command completed." }
      yield { type: "done" }
      return
    }
    if (prompt.includes("invalid")) {
      const invalidReadAlreadyAttempted = hasToolResult(input.messages, "read")
      if (!invalidReadAlreadyAttempted) {
        yield { type: "tool_call", call: call("read", {}) }
        yield { type: "done" }
        return
      }
      yield { type: "text_delta", text: "Invalid tool arguments surfaced." }
      yield { type: "done" }
      return
    }
    const fileAlreadyRead = hasToolResult(input.messages, "read")
    if (!fileAlreadyRead) {
      yield { type: "tool_call", call: call("read", { filePath: "src/add.ts" }) }
      yield { type: "done" }
      return
    }
    const fileAlreadyEdited = hasToolResult(input.messages, "edit")
    if (!fileAlreadyEdited) {
      yield { type: "tool_call", call: call("edit", { filePath: "src/add.ts", oldString: "return a - b", newString: "return a + b" }) }
      yield { type: "done" }
      return
    }
    const testsAlreadyRan = hasToolResult(input.messages, "bash")
    if (!testsAlreadyRan) {
      yield { type: "tool_call", call: call("bash", { command: "bun run test" }) }
      yield { type: "done" }
      return
    }
    const bash = latestToolResult(input.messages, "bash")
    yield { type: "text_delta", text: bash?.status === "succeeded" ? "Task passed." : "Task completed with tool feedback." }
    yield { type: "usage", inputTokens: 100, outputTokens: 20 }
    yield { type: "done" }
  }
}

function numberFromEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}
