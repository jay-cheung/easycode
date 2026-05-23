import { describe, expect, test } from "bun:test"
import { TimelineRenderer } from "../../src/ui/timeline"

describe("timeline renderer", () => {
  test("renders run start and provider wait progress", () => {
    let output = ""
    const renderer = new TimelineRenderer({ write: (text) => { output += text }, isTTY: false })

    renderer.event({ type: "run_start", mode: "build", provider: "deepseek", model: "deepseek-chat" })
    renderer.event({ type: "provider_progress", provider: "deepseek", model: "deepseek-chat", elapsedMs: 10_200 })

    expect(output).toContain("● Model deepseek deepseek-chat (build)")
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
    renderer.event({ type: "context_compaction", status: "completed", elapsedMs: 2_000, summaryChars: 128 })

    expect(output).toContain("● Context compaction")
    expect(output).toContain("summarizing older context, messages=4")
    expect(output).toContain("✓ Context compacted (2s), summary_chars=128")
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
})
