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
})
