import { describe, expect, test } from "bun:test"
import { desktopConfigCommand, desktopConfigSettingKeys, effortSettingsCommand, languageSettingsCommand, maxStepsSettingsCommand, maxTokensSettingsCommand, modelSettingsCommand, providerSettingsCommand, thinkingSettingsCommand, type DesktopConfigSettingValue } from "../../apps/desktop/src/renderer/settings-commands"
import { parseSlashCommand } from "../../src/slash"

describe("desktop settings slash commands", () => {
  test("maps settings controls to shared CLI slash commands", () => {
    const commands = [
      providerSettingsCommand("openai"),
      modelSettingsCommand("gpt-5.5"),
      modelSettingsCommand("   "),
      thinkingSettingsCommand(false),
      effortSettingsCommand("max"),
      languageSettingsCommand("zh"),
      maxTokensSettingsCommand(64_000),
      maxTokensSettingsCommand(undefined),
      maxStepsSettingsCommand(24),
      maxStepsSettingsCommand(undefined),
    ]

    expect(commands).toEqual([
      "/provider openai",
      "/model gpt-5.5",
      "/model reset",
      "/thinking off",
      "/effort max",
      "/lang zh",
      "/max-tokens 64000",
      "/max-tokens reset",
      "/max-steps 24",
      "/max-steps reset",
    ])

    for (const command of commands) {
      const parsed = parseSlashCommand(command)
      expect(parsed.type).not.toBe("unknown")
      expect(parsed.type).not.toBe("error")
    }
  })

  test("covers every desktop config key with a shared slash command", () => {
    const values: DesktopConfigSettingValue = {
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
      thinking: false,
      effort: "max",
      maxTokens: 64_000,
      maxSteps: 24,
    }
    const commands = desktopConfigSettingKeys.map((key) => desktopConfigCommand(key, values[key] as never))

    expect(desktopConfigSettingKeys).toEqual(["provider", "model", "language", "thinking", "effort", "maxTokens", "maxSteps"])
    expect(commands).toEqual([
      "/provider openai",
      "/model gpt-5.5",
      "/lang zh",
      "/thinking off",
      "/effort max",
      "/max-tokens 64000",
      "/max-steps 24",
    ])
    for (const command of commands) {
      expect(parseSlashCommand(command).type).not.toBe("error")
    }
  })
})
