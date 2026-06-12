import { describe, expect, test } from "bun:test"
import { createAgent } from "../../src/agent"

describe("agent protocol", () => {
  test("run mode carries unified planning and symbol-aware edit guidance", () => {
    const prompt = createAgent("build").systemPrompt

    expect(prompt).toContain("# Unified Run Mode - System Reminder")
    expect(prompt).toContain("EasyCode runs in one unified mode")
    expect(prompt).toContain("plan_exit")
    expect(prompt).toContain("symbol-aware edit plan")
    expect(prompt).toContain("target symbols")
    expect(prompt).toContain("excluded same-name matches")
  })

  test("legacy plan agent reuses the unified run protocol", () => {
    const prompt = createAgent("plan").systemPrompt

    expect(prompt).toContain("# Unified Run Mode - System Reminder")
    expect(prompt).toContain("Files likely to change")
    expect(prompt).toContain("target symbols")
    expect(prompt).not.toContain("read-only planning phase")
    expect(createAgent("plan").mode).toBe("build")
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
    expect(agent.role).toBe("summary")
    expect(agent.mode).toBe("plan")
    expect(agent.tools).toBe("none")
    expect(agent.systemPrompt).toContain("# Summary Agent - System Reminder")
    expect(agent.systemPrompt).toContain("Return the summary in <summary> tags")
  })

  test("explorer subagent is internal, tool-enabled, and non-recursive", () => {
    const agent = createAgent("explorer")

    expect(agent.kind).toBe("explorer")
    expect(agent.role).toBe("explorer")
    expect(agent.depth).toBe(1)
    expect(agent.mode).toBe("build")
    expect(agent.tools).toBe("enabled")
    expect(agent.systemPrompt).toContain("internal explorer subagent")
    expect(agent.systemPrompt).toContain("do not create or delegate any subagent")
  })
})
