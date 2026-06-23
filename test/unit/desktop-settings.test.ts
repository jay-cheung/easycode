import { describe, expect, test } from "bun:test"
import { normalizeSettings, normalizeSettingsForStorage } from "../../apps/desktop/src/main/settings-normalize"

describe("desktop settings", () => {
  test("uses env provider model only when it matches the resolved provider", () => {
    const settings = normalizeSettings({
      provider: "openai",
      workspaceRoot: "/workspace",
    }, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      language: "zh",
    })

    expect(settings.provider).toBe("openai")
    expect(settings.model).toBeUndefined()
    expect(settings.language).toBe("zh")
  })

  test("uses matching env provider model for first launch defaults", () => {
    const settings = normalizeSettings({
      workspaceRoot: "/workspace",
    }, {
      provider: "openai-compatible",
      model: "custom-model",
      language: "de",
    })

    expect(settings.provider).toBe("openai-compatible")
    expect(settings.model).toBe("custom-model")
    expect(settings.language).toBe("de")
  })

  test("persists explicit model reset without reapplying env model on reload", () => {
    const reset = normalizeSettingsForStorage({
      provider: "openai-compatible",
      workspaceRoot: "/workspace",
      model: undefined,
    })

    expect(reset.settings.model).toBeUndefined()
    expect(reset.stored.model).toBe("")

    const reloaded = normalizeSettings(reset.stored, {
      provider: "openai-compatible",
      model: "env-default-model",
    })
    expect(reloaded.model).toBeUndefined()
  })

  test("trims custom sidecar path and clears blank values", () => {
    expect(normalizeSettings({ workspaceRoot: "/workspace", sidecarPath: "  /bin/easycode  " }).sidecarPath).toBe("/bin/easycode")
    expect(normalizeSettings({ workspaceRoot: "/workspace", sidecarPath: "   " }).sidecarPath).toBeUndefined()
  })

  test("preserves recent workspace order when switching the active workspace", () => {
    expect(normalizeSettings({
      workspaceRoot: "/repo/b",
      recentWorkspaces: ["/repo/a", "/repo/b", "/repo/c"],
    }).recentWorkspaces).toEqual(["/repo/a", "/repo/b", "/repo/c"])

    expect(normalizeSettings({
      workspaceRoot: "/repo/d",
      recentWorkspaces: ["/repo/a", "/repo/b"],
    }).recentWorkspaces).toEqual(["/repo/a", "/repo/b", "/repo/d"])
  })

  test("normalizes run limits like sidecar session settings", () => {
    expect(normalizeSettings({ workspaceRoot: "/workspace", maxTokens: 1_000_000, maxSteps: 10_000 })).toMatchObject({
      maxTokens: 256_000,
      maxSteps: 200,
    })
    expect(normalizeSettings({ workspaceRoot: "/workspace", maxTokens: -1, maxSteps: Number.NaN })).toMatchObject({
      maxTokens: undefined,
      maxSteps: undefined,
    })
  })
})
