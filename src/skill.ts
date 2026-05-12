import path from "node:path"
import os from "node:os"
import { readdir } from "node:fs/promises"

export type SkillInfo = {
  name: string
  description: string
  location: string
  content?: string
}

export interface SkillServiceLike {
  available(): Promise<SkillInfo[]>
  load(name: string): Promise<SkillInfo | undefined>
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
  private cache?: SkillInfo[]

  constructor(projectRoot: string, roots?: string[]) {
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
      const skills: SkillInfo[] = []
      for (const file of files) {
        const parsed = parseFrontmatter(await Bun.file(file).text())
        const name = parsed.data.get("name")
        const description = parsed.data.get("description")
        if (name && description) skills.push({ name, description, location: file })
      }
      this.cache = skills.sort((left, right) => left.name.localeCompare(right.name))
    }
    return this.cache.map((skill) => ({ ...skill, content: undefined }))
  }

  async load(name: string) {
    const skill = (await this.available()).find((item) => item.name === name)
    if (!skill) return undefined
    const parsed = parseFrontmatter(await Bun.file(skill.location).text())
    return { ...skill, content: parsed.content }
  }
}
