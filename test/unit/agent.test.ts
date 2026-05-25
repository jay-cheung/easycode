import { describe, expect, test } from "bun:test"
import { createAgent } from "../../src/agent"

describe("agent protocol", () => {
  test("plan mode carries a strict planning workflow", () => {
    const prompt = createAgent("plan").systemPrompt

    expect(prompt).toContain("# Plan Mode - System Reminder")
    expect(prompt).toContain("read-only planning phase")
    expect(prompt).toContain("End the turn by calling the plan_exit tool")
    expect(prompt).toContain("Files likely to change")
  })
})
