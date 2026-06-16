import { describe, expect, test } from "bun:test"
import { parseSlashCommand } from "../../src/slash"
import { defaultSessionSettings, normalizeSessionSettings } from "../../src/settings"

describe("slash commands", () => {
  test("parses prompt escape and common commands", () => {
    expect(parseSlashCommand("//help")).toEqual({ type: "prompt", text: "/help" })
    expect(parseSlashCommand("/image screenshot.png")).toEqual({ type: "image", action: "add", value: "screenshot.png" })
    expect(parseSlashCommand("/skill use demo")).toEqual({ type: "skill", action: "use", name: "demo" })
    expect(parseSlashCommand("/model gpt-5-mini")).toEqual({ type: "model", model: "gpt-5-mini" })
    expect(parseSlashCommand("/model gpt-4o with spaces")).toEqual({ type: "model", model: "gpt-4o with spaces" })
    expect(parseSlashCommand("/provider openai")).toEqual({ type: "provider", name: "openai" })
    expect(parseSlashCommand("/effort max")).toEqual({ type: "effort", value: "max" })
    expect(parseSlashCommand("/lang zh")).toEqual({ type: "lang", value: "zh" })
    expect(parseSlashCommand("/lang")).toEqual({ type: "lang" })
    expect(parseSlashCommand("/plan fix the flaky test")).toEqual({ type: "plan", objective: "fix the flaky test" })
    expect(parseSlashCommand("/goal")).toEqual({ type: "goal", action: "status" })
    expect(parseSlashCommand("/goal pause")).toEqual({ type: "goal", action: "pause" })
    expect(parseSlashCommand("/goal resume")).toEqual({ type: "goal", action: "resume" })
    expect(parseSlashCommand("/goal clear")).toEqual({ type: "goal", action: "clear" })
    expect(parseSlashCommand("/goal implement goal mode")).toEqual({ type: "goal", action: "start", objective: "implement goal mode" })
    expect(parseSlashCommand("/sessions")).toEqual({ type: "sessions" })
    expect(parseSlashCommand("/session switch archive")).toEqual({ type: "session", action: "switch", target: "archive" })
    expect(parseSlashCommand("/session delete archive")).toEqual({ type: "session", action: "delete", target: "archive" })
    expect(parseSlashCommand("/task")).toEqual({ type: "unknown", name: "task" })
    expect(parseSlashCommand("/task list")).toEqual({ type: "unknown", name: "task" })
  })

  test("returns error for model and provider with no args", () => {
    expect(parseSlashCommand("/model")).toEqual({ type: "error", code: "model_requires_name" })
    expect(parseSlashCommand("/provider")).toEqual({ type: "error", code: "provider_requires_name" })
    expect(parseSlashCommand("/plan")).toEqual({ type: "error", code: "plan_requires_objective" })
    expect(parseSlashCommand("/session switch")).toEqual({ type: "error", code: "session_switch_requires_name" })
    expect(parseSlashCommand("/session delete")).toEqual({ type: "error", code: "session_delete_requires_name" })
  })

  test("accepts the thingking typo as a thinking alias", () => {
    expect(parseSlashCommand("/thingking off")).toEqual({ type: "thinking", value: "off", aliasUsed: true })
    expect(parseSlashCommand("/thinking on")).toEqual({ type: "thinking", value: "on", aliasUsed: false })
  })

  test("normalizes session settings", () => {
    expect(defaultSessionSettings("openai")).toMatchObject({ provider: "openai", language: expect.any(String), thinking: true, effort: "high", maxTokens: 64_000, maxSteps: 66 })
    expect(normalizeSessionSettings({ provider: "deepseek", effort: "max", selectedSkills: ["demo", "demo", ""], pendingSkillLoads: ["demo", "demo", ""] }, "fake")).toMatchObject({
      provider: "deepseek",
      effort: "max",
      selectedSkills: ["demo"],
      pendingSkillLoads: ["demo"],
    })
    expect(normalizeSessionSettings({ selectedSkills: ["demo"] }, "fake")).toMatchObject({ selectedSkills: ["demo"], pendingSkillLoads: ["demo"] })
  })
})
