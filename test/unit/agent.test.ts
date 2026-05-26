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
