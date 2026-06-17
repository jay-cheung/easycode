import { describe, expect, test } from "bun:test"
import { TimelineRenderer } from "../../src/ui/timeline"

describe("timeline renderer", () => {
  test("renders run start and provider wait progress", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "run_start", mode: "build", provider: "deepseek", model: "deepseek-chat" })
    renderer.event({ type: "provider_progress", provider: "deepseek", model: "deepseek-chat", elapsedMs: 10_200 })

    expect(output).toContain("● Model deepseek deepseek-chat (run)")
    expect(output).toContain("waiting for deepseek deepseek-chat after 10s")
  })

  test("renders bash progress and final duration", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "tool_call", call: { id: "call_1", name: "bash", input: { command: "sleep 2" } } })
    renderer.event({ type: "tool_progress", callID: "call_1", toolName: "bash", elapsedMs: 12_300 })
    renderer.event({ type: "tool_result", callID: "call_1", toolName: "bash", title: "sleep 2", status: "succeeded", output: "done", durationMs: 2_050 })

    expect(output).toContain("● bash sleep 2")
    expect(output).toContain("bash still running after 12s")
    expect(output).toContain("✓ sleep 2 (2s)")
    expect(output).toContain("done")
  })

  test("renders repo map prewarm status", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "repo_map", status: "succeeded", cacheHit: true, files: 12, relevantFiles: 3, cachePath: ".easycode/cache/repo-map.json" })

    expect(output).toContain("● repo_map prewarm")
    expect(output).toContain("cache hit")
    expect(output).toContain("files=12")
    expect(output).toContain("relevant=3")
  })

  test("renders context compaction status", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "context_compaction", status: "started", inputMessages: 4 })
    renderer.event({ type: "context_compaction", status: "completed", elapsedMs: 2_000, summaryChars: 128, summaryTokens: 32 })

    expect(output).toContain("● Context compaction")
    expect(output).toContain("summarizing older context, messages=4")
    expect(output).toContain("✓ Context compacted (2s), summary_chars=128, summary_tokens=32")
  })

  test("renders subagent scheduling and completion", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({
      type: "subagent",
      status: "scheduled",
      info: {
        id: 1,
        role: "summary",
        provider: "openai",
        model: "gpt-5-mini",
        thinking: true,
        effort: "low",
        maxProviderCalls: 1,
        maxOutputTokens: 900,
      },
    })
    renderer.event({
      type: "subagent",
      status: "completed",
      info: {
        id: 1,
        role: "summary",
        provider: "openai",
        model: "gpt-5-mini",
        thinking: true,
        effort: "low",
        maxProviderCalls: 1,
        maxOutputTokens: 900,
      },
      elapsedMs: 1_500,
      metrics: {
        provider: "openai",
        model: "gpt-5-mini",
        source: "subagent",
        subagentRole: "summary",
        thinking: true,
        effort: "low",
        maxOutputTokens: 900,
        maxProviderCalls: 1,
        calls: 1,
        inputTokens: 120,
        outputTokens: 40,
        cacheHitTokens: 0,
        cacheMissTokens: 120,
        totalTokens: 160,
        reasoningTokens: 10,
        hitRate: 0,
        providerElapsedMs: 1_500,
        firstResponseMs: 300,
        outputTokensPerSecond: 26.6,
        effectiveCost: 0,
        rates: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
      },
    })

    expect(output).toContain("● Subagent scheduled id=1, role=summary, provider=openai gpt-5-mini, thinking=on, effort=low, max_calls=1, max_output_tokens=900")
    expect(output).toContain("✓ Subagent #1 summary completed (1.5s)\n    calls=1, input_tokens=120, output_tokens=40")
  })

  test("renders provider failures separately from answer text", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "text_delta", text: "Model partial answer." })
    renderer.event({ type: "failure", text: "The socket connection was closed unexpectedly.", source: "provider", category: "network" })
    renderer.finish()

    expect(output).toContain("● Answer")
    expect(output).toContain("Model partial answer.")
    expect(output).toContain("● Network Error")
    expect(output).toContain("The socket connection was closed unexpectedly.")
  })

  test("renders provider metrics with APIx usage and latency labels", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({
      type: "provider_metrics",
      metrics: {
        provider: "deepseek",
        model: "deepseek-chat",
        calls: 2,
        inputTokens: 100,
        outputTokens: 20,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
        totalTokens: 120,
        reasoningTokens: 5,
        hitRate: 0.8,
        providerElapsedMs: 2_000,
        firstResponseMs: 250,
        outputTokensPerSecond: 10,
        effectiveCost: 61.6,
        rates: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 },
      },
    })

    expect(output).toContain("● Metrics")
    expect(output).toContain("provider deepseek deepseek-chat")
    expect(output).toContain("latency=2s")
    expect(output).toContain("ttft=250ms")
    expect(output).toContain("usage input=100 cached=80 miss=20 hit_rate=80.0% output=20 reasoning=5 total=120")
    expect(output).toContain("cost effective=61.6")
  })

  test("renders markdown formatting in answer text for tty output", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: true })

    renderer.event({ type: "text_delta", text: "# Summary\n- **Done** with `src/ui/timeline.ts`\n```ts\nconst ok = true\n```\n" })
    renderer.finish()

    expect(output).toContain("\x1b[1mSummary\x1b[0m")
    expect(output).toContain("- \x1b[1mDone\x1b[0m with \x1b[90msrc/ui/timeline.ts\x1b[0m")
    expect(output).toContain("\x1b[2m    const ok = true\x1b[0m")
    expect(output).not.toContain("# Summary")
    expect(output).not.toContain("```")
  })

  test("renders markdown formatting in answer text without ansi for non-tty output", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "text_delta", text: "# Summary\n- **Done** with `src/ui/timeline.ts`\n" })
    renderer.finish()

    expect(output).toContain("Summary")
    expect(output).toContain("- Done with src/ui/timeline.ts")
    expect(output).not.toContain("# Summary")
    expect(output).not.toContain("**Done**")
    expect(output).not.toContain("`src/ui/timeline.ts`")
  })

  test("buffers partial answer lines before rendering markdown", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "text_delta", text: "# Head" })
    renderer.event({ type: "text_delta", text: "ing\n- **Bo" })
    renderer.event({ type: "text_delta", text: "ld** item" })
    renderer.finish()

    expect(output).toContain("Heading")
    expect(output).toContain("- Bold item")
    expect(output).not.toContain("# Heading")
    expect(output).not.toContain("**Bold**")
  })

  test("renders markdown tables in answer text", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "text_delta", text: "| Name | Purpose |\n|---|---|\n| ReadInput | Read files |\n| RgSearchInput | Search code |\n" })
    renderer.finish()

    expect(output).toContain("+---------------+-------------+")
    expect(output).toContain("| Name          | Purpose     |")
    expect(output).toContain("| ReadInput     | Read files  |")
    expect(output).toContain("| RgSearchInput | Search code |")
    expect(output).not.toContain("|---|---|")
  })

  test("buffers partial table rows before rendering markdown tables", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "text_delta", text: "| Name | Purpose |\n|---|---|\n| Read" })
    renderer.event({ type: "text_delta", text: "Input | Read files |" })
    renderer.finish()

    expect(output).toContain("| Name      | Purpose    |")
    expect(output).toContain("| ReadInput | Read files |")
    expect(output).not.toContain("|---|---|")
  })

  test("wraps markdown table cells to the terminal width", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false, columns: 42 })

    renderer.event({ type: "text_delta", text: "| 轮次 | 你说的 | 我回的 |\n|:---|---|---|\n| ① | 你是谁 | 介绍了我是 EasyCode 的 AI 编程助手，擅长代码探索、编写、重构、调试 |\n" })
    renderer.finish()

    expect(output).toContain("+------+--------+------------------------+")
    expect(output).toContain("| ①    | 你是谁 | 介绍了我是 EasyCode 的 |")
    expect(output).toContain("|      |        | AI 编程助手，擅长代码  |")
    expect(output).not.toContain("|:---|---|---|")
  })
})
