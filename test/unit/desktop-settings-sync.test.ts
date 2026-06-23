import { describe, expect, test } from "bun:test"
import { desktopConfigSettingKeys } from "../../apps/desktop/src/renderer/settings-commands"
import { applyDirectDesktopSettings, reconcileDesktopSettingsFromSidecar, restoreLoadedSessionSettings, sidecarSettingsPatch } from "../../apps/desktop/src/renderer/settings-sync"
import type { DesktopSettings, DesktopSettingsPatch } from "../../apps/desktop/src/shared/protocol"

const baseSettings: DesktopSettings = {
  workspaceRoot: "/repo",
  provider: "fake",
  language: "en",
  thinking: true,
  effort: "high",
  selectedSkills: [],
  pendingSkillLoads: [],
  session: "default",
  recentWorkspaces: ["/repo"],
}

class FakeSettingsApi {
  readonly calls: Array<{ method: string; input?: unknown }> = []

  async updateSettings(settings: Partial<DesktopSettings>) {
    this.calls.push({ method: "updateSettings", input: settings })
    return { ...baseSettings, ...settings }
  }

  async initialize() {
    this.calls.push({ method: "initialize" })
    return {}
  }

  async updateSidecarSettings(settings: DesktopSettingsPatch) {
    this.calls.push({ method: "updateSidecarSettings", input: settings })
    return {
      settings: {
        ...baseSettings,
        ...settings,
        model: settings.model ?? undefined,
        maxTokens: settings.maxTokens ?? undefined,
        maxSteps: settings.maxSteps ?? undefined,
      },
    }
  }
}

describe("desktop settings sync", () => {
  test("sends only explicit UI settings fields to the sidecar", () => {
    expect(sidecarSettingsPatch({ language: "zh" })).toEqual({ language: "zh" })
    expect(sidecarSettingsPatch({ thinking: false, effort: "medium" })).toEqual({ thinking: false, effort: "medium" })
    expect(sidecarSettingsPatch({})).toEqual({})
  })

  test("preserves explicit reset semantics for nullable session settings", () => {
    expect(sidecarSettingsPatch({ model: undefined })).toEqual({ model: null })
    expect(sidecarSettingsPatch({ maxTokens: undefined, maxSteps: undefined })).toEqual({ maxTokens: null, maxSteps: null })
  })

  test("covers every desktop-controlled sidecar setting", () => {
    const patch = sidecarSettingsPatch({
      provider: "openai",
      model: "gpt-5.5",
      language: "de",
      thinking: true,
      effort: "high",
      maxTokens: 64000,
      maxSteps: 24,
      selectedSkills: ["demo"],
      pendingSkillLoads: ["demo"],
      session: "scratch",
    })
    expect(patch).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      language: "de",
      thinking: true,
      effort: "high",
      maxTokens: 64000,
      maxSteps: 24,
      selectedSkills: ["demo"],
      pendingSkillLoads: ["demo"],
      session: "scratch",
    })
    expect(desktopConfigSettingKeys.every((key) => Object.prototype.hasOwnProperty.call(patch, key))).toBe(true)
  })

  test("does not echo sidecar slash settings back to the sidecar", async () => {
    const api = new FakeSettingsApi()

    const next = await reconcileDesktopSettingsFromSidecar(api, { language: "zh", model: "deepseek-v4-flash" })

    expect(next).toMatchObject({ language: "zh", model: "deepseek-v4-flash" })
    expect(api.calls).toEqual([
      { method: "updateSettings", input: { language: "zh", model: "deepseek-v4-flash" } },
      { method: "initialize" },
    ])
  })

  test("keeps direct desktop settings synchronized into the sidecar", async () => {
    const api = new FakeSettingsApi()

    const next = await applyDirectDesktopSettings(api, { model: undefined, maxSteps: 12 })

    expect(next.maxSteps).toBe(12)
    expect(next.model).toBeUndefined()
    expect(api.calls).toEqual([
      { method: "updateSettings", input: { model: undefined, maxSteps: 12 } },
      { method: "initialize" },
      { method: "updateSidecarSettings", input: { model: null, maxSteps: 12 } },
      { method: "updateSettings", input: { ...baseSettings, model: undefined, maxSteps: 12 } },
    ])
  })

  test("restores loaded session settings into the sidecar before the next run", async () => {
    const api = new FakeSettingsApi()

    const next = await restoreLoadedSessionSettings(api, "configured", {
      provider: "fake",
      model: "fake-custom-model",
      language: "zh",
      thinking: false,
      effort: "medium",
      maxTokens: 12345,
      maxSteps: 23,
      selectedSkills: ["demo"],
      pendingSkillLoads: ["demo"],
    })

    expect(next).toMatchObject({ session: "configured", model: "fake-custom-model", language: "zh", maxSteps: 23 })
    expect(api.calls).toEqual([
      {
        method: "updateSettings",
        input: {
          provider: "fake",
          model: "fake-custom-model",
          language: "zh",
          thinking: false,
          effort: "medium",
          maxTokens: 12345,
          maxSteps: 23,
          selectedSkills: ["demo"],
          pendingSkillLoads: ["demo"],
          session: "configured",
        },
      },
      { method: "initialize" },
    ])
  })
})
