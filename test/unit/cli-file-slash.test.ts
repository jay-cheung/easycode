import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { handleSlashCommand } from "../../src/cli/session-helpers"
import { defaultSessionSettings, maxSessionSteps, maxSessionTokens } from "../../src/settings"
import { parseSlashCommand } from "../../src/slash"
import { SkillService } from "../../src/skill"

describe("cli file slash attachments", () => {
  test("adds and clears pending workspace files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-cli-file-"))
    await Bun.write(path.join(root, "add.ts"), "export const add = (a: number, b: number) => a + b\n")
    const settings = defaultSessionSettings("fake")
    const skills = new SkillService(root)

    const addCommand = parseSlashCommand("/file add.ts")
    if (addCommand.type === "prompt") throw new Error("expected slash command")
    const added = await handleSlashCommand(addCommand, { root, settings, pendingImages: [], pendingFiles: [], skills })
    expect(added.pendingFiles).toEqual([path.join(root, "add.ts")])

    const clearCommand = parseSlashCommand("/file clear")
    if (clearCommand.type === "prompt") throw new Error("expected slash command")
    const cleared = await handleSlashCommand(clearCommand, { root, settings: added.settings, pendingImages: [], pendingFiles: added.pendingFiles, skills })
    expect(cleared.pendingFiles).toEqual([])

    await rm(root, { recursive: true, force: true })
  })

  test("updates run limits through shared slash handling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-cli-limits-"))
    const settings = defaultSessionSettings("fake")
    const skills = new SkillService(root)

    const tokenCommand = parseSlashCommand(`/max-tokens ${maxSessionTokens + 1}`)
    if (tokenCommand.type === "prompt") throw new Error("expected slash command")
    const tokenResult = await handleSlashCommand(tokenCommand, { root, settings, pendingImages: [], pendingFiles: [], skills })
    expect(tokenResult.settings.maxTokens).toBe(maxSessionTokens)

    const stepCommand = parseSlashCommand(`/max-steps ${maxSessionSteps + 1}`)
    if (stepCommand.type === "prompt") throw new Error("expected slash command")
    const stepResult = await handleSlashCommand(stepCommand, { root, settings: tokenResult.settings, pendingImages: [], pendingFiles: [], skills })
    expect(stepResult.settings.maxSteps).toBe(maxSessionSteps)

    const resetCommand = parseSlashCommand("/max-tokens reset")
    if (resetCommand.type === "prompt") throw new Error("expected slash command")
    const resetResult = await handleSlashCommand(resetCommand, { root, settings: stepResult.settings, pendingImages: [], pendingFiles: [], skills })
    expect(resetResult.settings.maxTokens).toBe(defaultSessionSettings("fake").maxTokens)

    await rm(root, { recursive: true, force: true })
  })

  test("resets model through shared slash handling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-cli-model-"))
    const settings = { ...defaultSessionSettings("fake"), model: "custom-model" }
    const skills = new SkillService(root)

    const resetCommand = parseSlashCommand("/model reset")
    if (resetCommand.type === "prompt") throw new Error("expected slash command")
    const resetResult = await handleSlashCommand(resetCommand, { root, settings, pendingImages: [], pendingFiles: [], skills })

    expect(resetResult.settings.model).toBeUndefined()
    expect(resetResult.resetRunner).toBe(true)

    await rm(root, { recursive: true, force: true })
  })
})
