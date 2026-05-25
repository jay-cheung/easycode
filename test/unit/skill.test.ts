import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { SkillService } from "../../src/skill"

function normalizePath(p: string) {
  return p.replace(/\\/g, "/")
}

describe("skill", () => {
  test("loads descriptions progressively", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-skill-"))
    const dir = path.join(root, ".easycode", "skills", "demo")
    await mkdir(dir, { recursive: true })
    const skillFile = path.join(dir, "SKILL.md")
    await Bun.write(skillFile, "---\nname: demo\ndescription: Demo description\n---\nFull prompt")
    const service = new SkillService(root)
    const available = await service.available()
    expect(available[0].content).toBeUndefined()
    expect(available[0].id).toBe(normalizePath(path.relative(root, skillFile)))
    expect(available[0].name).toBe("demo")
    const loaded = await service.load("demo")
    expect(loaded?.content).toBe("Full prompt")
    expect(loaded?.id).toBe(available[0].id)
    await rm(root, { recursive: true, force: true })
  })

  test("loads project .agent skills with lowercase skill file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-skill-"))
    const dir = path.join(root, ".agent", "skills", "demo")
    await mkdir(dir, { recursive: true })
    const skillFile = path.join(dir, "skill.md")
    await Bun.write(skillFile, "---\nname: demo\ndescription: Agent skill\n---\nAgent prompt")
    const service = new SkillService(root)
    const expected = {
      id: normalizePath(path.relative(root, skillFile)),
      name: "demo",
      description: "Agent skill",
      location: skillFile,
      content: undefined,
    }
    expect(await service.available()).toEqual([expected])
    expect((await service.load("demo"))?.content).toBe("Agent prompt")
    await rm(root, { recursive: true, force: true })
  })

  test("generates unique id per location and deduplicates by id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-skill-"))
    // Two skills with same name in different root directories
    await mkdir(path.join(root, ".easycode", "skills", "alpha"), { recursive: true })
    await mkdir(path.join(root, ".agent", "skills", "alpha"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "alpha", "skill.md"), "---\nname: dup\ndescription: Easycode version\n---\nEasycode content")
    await Bun.write(path.join(root, ".agent", "skills", "alpha", "skill.md"), "---\nname: dup\ndescription: Agent version\n---\nAgent content")
    const service = new SkillService(root)
    const available = await service.available()
    expect(available).toHaveLength(2)
    // Both have same name but different ids
    expect(available[0].name).toBe("dup")
    expect(available[1].name).toBe("dup")
    expect(available[0].id).not.toBe(available[1].id)
    // Loading by id should get the correct one
    const loaded = await service.load(available[0].id)
    expect(loaded?.description).toBe(available[0].description)
    expect(loaded?.location).toBe(available[0].location)
    await rm(root, { recursive: true, force: true })
  })

  test("skips files without name or description frontmatter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-skill-"))
    await mkdir(path.join(root, ".easycode", "skills", "incomplete"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "incomplete", "skill.md"), "---\nname: only-name\n---\nNo description")
    await mkdir(path.join(root, ".easycode", "skills", "valid"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "valid", "skill.md"), "---\nname: valid\ndescription: Has both\n---\nValid content")
    const service = new SkillService(root)
    const available = await service.available()
    expect(available).toHaveLength(1)
    expect(available[0].name).toBe("valid")
    await rm(root, { recursive: true, force: true })
  })

  test("load by name works for backward compatibility", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-skill-"))
    await mkdir(path.join(root, ".easycode", "skills", "legacy"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "legacy", "skill.md"), "---\nname: legacy-skill\ndescription: Legacy\n---\nLegacy content")
    const service = new SkillService(root)
    // Old code stores name in settings, loading by name still works
    const loaded = await service.load("legacy-skill")
    expect(loaded).toBeDefined()
    expect(loaded?.content).toBe("Legacy content")
    await rm(root, { recursive: true, force: true })
  })
})
