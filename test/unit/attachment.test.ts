import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { attachedFileFromInput, promptWithAttachedFiles } from "../../src/attachment"

describe("workspace file attachments", () => {
  test("formats attached files as workspace-relative prompt references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-attachment-"))
    await Bun.write(path.join(root, "add.ts"), "export const add = (a: number, b: number) => a + b\n")

    const file = await attachedFileFromInput(root, "add.ts")
    const prompt = await promptWithAttachedFiles(root, "inspect this", [file.path])

    expect(file.relativePath).toBe("add.ts")
    expect(prompt).toContain("<attached_files>")
    expect(prompt).toContain("- add.ts")
    expect(prompt).not.toContain(root)
    await rm(root, { recursive: true, force: true })
  })

  test("rejects files outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-attachment-"))
    const outside = path.join(os.tmpdir(), `easycode-attachment-outside-${Date.now()}.txt`)
    await Bun.write(outside, "outside")

    await expect(attachedFileFromInput(root, outside)).rejects.toThrow("Attached file must be inside the workspace")

    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  })
})
