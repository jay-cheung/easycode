import path from "node:path"
import os from "node:os"
import { readdir } from "node:fs/promises"

export type SkillInfo = {
  id: string
  name: string
  description: string
  location: string
  content?: string
}

export interface SkillServiceLike {
  available(): Promise<SkillInfo[]>
  load(nameOrId: string): Promise<SkillInfo | undefined>
}

function parseFrontmatter(text: string) {
  if (!text.startsWith("---\n")) return { data: new Map<string, string>(), content: text }
  const end = text.indexOf("\n---", 4)
  if (end === -1) return { data: new Map<string, string>(), content: text }
  const data = new Map<string, string>()
  for (const line of text.slice(4, end).trim().split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    data.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, ""))
  }
  return { data, content: text.slice(end + 4).trim() }
}

async function isDir(dir: string) {
  return readdir(dir).then(() => true).catch(() => false)
}

async function skillFiles(dir: string): Promise<string[]> {
  if (!(await isDir(dir))) return []
  const out: string[] = []
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") out.push(full)
    }
  }
  await walk(dir)
  return out
}

export class SkillService implements SkillServiceLike {
  readonly roots: string[]
  private readonly projectRoot: string
  private cache?: SkillInfo[]

  constructor(projectRoot: string, roots?: string[]) {
    this.projectRoot = projectRoot
    this.roots = roots ?? [
      path.join(projectRoot, ".agent", "skills"),
      path.join(projectRoot, ".easycode", "skills"),
      path.join(os.homedir(), ".agent", "skills"),
      path.join(os.homedir(), ".easycode", "skills"),
    ]
  }

  async available() {
    if (!this.cache) {
      const files = (await Promise.all(this.roots.map(skillFiles))).flat()
      const seenNames = new Map<string, string[]>() // name -> [file, loc]
      const skills: SkillInfo[] = []
      for (const file of files) {
        const parsed = parseFrontmatter(await Bun.file(file).text())
        const name = parsed.data.get("name")
        const description = parsed.data.get("description")
        if (!name || !description) continue
        const id = path.relative(this.projectRoot, file).replace(/\\/g, "/")
        // Dedup by id (silently skip if the same id appears twice)
        if (skills.some((s) => s.id === id)) continue
        // Track duplicate names for warning (last unique id wins)
        const prev = seenNames.get(name)
        if (prev) prev.push(id)
        else seenNames.set(name, [id])
        skills.push({ id, name, description, location: file })
      }
      this.cache = skills.sort((left, right) => left.name.localeCompare(right.name))
    }
    return this.cache.map((skill) => ({ ...skill, content: undefined }))
  }

  async load(nameOrId: string) {
    const skills = await this.available()
    // Try exact id match first, then exact name match (backward compat)
    const skill = skills.find((item) => item.id === nameOrId || item.name === nameOrId)
    if (!skill) return undefined
    const parsed = parseFrontmatter(await Bun.file(skill.location).text())
    return { ...skill, content: parsed.content }
  }
}
