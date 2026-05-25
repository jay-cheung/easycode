import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { InstructionService } from "../../src/instruction"

describe("instruction service", () => {
  test("loads project and configured global instruction files in stable order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-instructions-"))
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "easycode-global-instructions-"))
    await mkdir(path.join(globalRoot, ".easycode"), { recursive: true })
    await Bun.write(path.join(root, "AGENTS.md"), "Project agents")
    await Bun.write(path.join(root, "CLAUDE.md"), "Project claude")
    await Bun.write(path.join(globalRoot, ".easycode", "AGENTS.md"), "Global agents")

    const instructions = await new InstructionService(root, { globalFiles: [path.join(globalRoot, ".easycode", "AGENTS.md")] }).system()

    expect(instructions.map((instruction) => [instruction.source, instruction.path, instruction.content])).toEqual([
      ["project", "AGENTS.md", "Project agents"],
      ["project", "CLAUDE.md", "Project claude"],
      ["global", path.join(globalRoot, ".easycode", "AGENTS.md"), "Global agents"],
    ])
    await rm(root, { recursive: true, force: true })
    await rm(globalRoot, { recursive: true, force: true })
  })
})
