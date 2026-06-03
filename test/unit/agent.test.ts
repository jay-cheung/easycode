import { describe, expect, test } from "bun:test"
import { createAgent } from "../../src/agent"

describe("agent protocol", () => {
  test("build mode carries symbol-aware edit planning guidance", () => {
    const prompt = createAgent("build").systemPrompt

    expect(prompt).toContain("# Build Mode - System Reminder")
    expect(prompt).toContain("symbol-aware edit plan")
    expect(prompt).toContain("target symbols")
    expect(prompt).toContain("excluded same-name matches")
    expect(prompt).toContain("stop immediately")
  })

  test("plan mode carries a strict planning workflow", () => {
    const prompt = createAgent("plan").systemPrompt

    expect(prompt).toContain("# Plan Mode - System Reminder")
    expect(prompt).toContain("read-only planning phase")
    expect(prompt).toContain("End the turn by calling the plan_exit tool")
    expect(prompt).toContain("Files likely to change")
    expect(prompt).toContain("target symbols")
    expect(prompt).toContain("excluded same-name matches")
  })

  test("stable protocol forbids uncertainty-driven rollback language", () => {
    const prompt = createAgent("build").systemPrompt

    expect(prompt).toContain("strict one-way execution flow")
    expect(prompt).toContain("\"wait\"")
    expect(prompt).toContain("\"actually\"")
    expect(prompt).toContain("\"let me re-read\"")
    expect(prompt).toContain("\"maybe\"")
    expect(prompt).toContain("keep it locked")
  })

  test("summary agent is internal and tool-free", () => {
    const agent = createAgent("summary")

    expect(agent.kind).toBe("summary")
    expect(agent.name).toBe("summary")
    expect(agent.mode).toBe("plan")
    expect(agent.tools).toBe("none")
    expect(agent.systemPrompt).toContain("# Summary Agent - System Reminder")
    expect(agent.systemPrompt).toContain("Return the summary in <summary> tags")
  })
})
