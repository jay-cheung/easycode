import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { SkillService } from "../../src/skill"

describe("skill", () => {
  test("loads descriptions progressively", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-skill-"))
    const dir = path.join(root, ".easycode", "skills", "demo")
    await mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "SKILL.md"), "---\nname: demo\ndescription: Demo description\n---\nFull prompt")
    const service = new SkillService(root)
    expect((await service.available())[0].content).toBeUndefined()
    expect((await service.load("demo"))?.content).toBe("Full prompt")
    await rm(root, { recursive: true, force: true })
  })
})
