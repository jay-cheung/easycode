import { describe, expect, test } from "bun:test"
import { parseSlashCommand } from "../../src/slash"
import { defaultSessionSettings, normalizeSessionSettings } from "../../src/settings"

describe("slash commands", () => {
  test("parses prompt escape and common commands", () => {
    expect(parseSlashCommand("//help")).toEqual({ type: "prompt", text: "/help" })
    expect(parseSlashCommand("/image screenshot.png")).toEqual({ type: "image", action: "add", value: "screenshot.png" })
    expect(parseSlashCommand("/skill use demo")).toEqual({ type: "skill", action: "use", name: "demo" })
    expect(parseSlashCommand("/model openai gpt-5-mini")).toEqual({ type: "model", provider: "openai", model: "gpt-5-mini" })
    expect(parseSlashCommand("/effort max")).toEqual({ type: "effort", value: "max" })
  })

  test("accepts the thingking typo as a thinking alias", () => {
    expect(parseSlashCommand("/thingking off")).toEqual({ type: "thinking", value: "off", aliasUsed: true })
    expect(parseSlashCommand("/thinking on")).toEqual({ type: "thinking", value: "on", aliasUsed: false })
  })

  test("normalizes session settings", () => {
    expect(defaultSessionSettings("openai")).toMatchObject({ provider: "openai", thinking: true, effort: "high" })
    expect(normalizeSessionSettings({ provider: "deepseek", effort: "max", selectedSkills: ["demo", "demo", ""] }, "fake")).toMatchObject({
      provider: "deepseek",
      effort: "max",
      selectedSkills: ["demo"],
    })
  })
})

