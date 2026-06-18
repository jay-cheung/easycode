import path from "node:path"
import os from "node:os"
import { readdir, stat } from "node:fs/promises"
import { easycodeDir } from "../easycode-path"

export type SkillArtifact = {
  reference: string
  path: string
  resolvedPath: string
  kind: "file" | "directory" | "missing"
  source: "markdown_link" | "inline_code"
}

type ExtractedSkillReference = {
  offset: number
  source: SkillArtifact["source"]
  reference: string
}

export type SkillInfo = {
  id: string
  name: string
  description: string
  location: string
  content?: string
  artifacts?: SkillArtifact[]
}

export type SkillDiagnostic = {
  code: "read_failed" | "missing_required_frontmatter" | "duplicate_name"
  message: string
  location?: string
  name?: string
  ids?: string[]
}

export interface SkillServiceLike {
  available(): Promise<SkillInfo[]>
  load(nameOrId: string): Promise<SkillInfo | undefined>
  diagnostics?(): Promise<SkillDiagnostic[]>
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

function* extractMarkdownLinks(text: string): Generator<ExtractedSkillReference> {
  const regex = /\[[^\]]*\]\(([^)]+)\)/g
  for (const match of text.matchAll(regex)) {
    const candidate = normalizeReference(match[1] ?? "")
    if (candidate) yield { offset: match.index ?? 0, source: "markdown_link" as const, reference: candidate }
  }
}

function* extractInlineCodePaths(text: string): Generator<ExtractedSkillReference> {
  const regex = /`([^`\n]+)`/g
  for (const match of text.matchAll(regex)) {
    const candidate = normalizeReference(match[1] ?? "")
    if (looksLikeLocalPathCandidate(candidate)) yield { offset: match.index ?? 0, source: "inline_code" as const, reference: candidate }
  }
}

function normalizeReference(value: string) {
  const trimmed = value.trim().replace(/^<|>$/g, "")
  if (!trimmed) return ""
  const titleSplit = trimmed.match(/^(\S+)\s+["'][^"']+["']$/)
  return titleSplit ? titleSplit[1] : trimmed
}

function looksLikeLocalPathCandidate(value: string) {
  if (!value || value.includes("://") || value.startsWith("#") || value.startsWith("--")) return false
  if (value.includes(" ")) return false
  if (value.startsWith("~/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) return true
  if (value.endsWith("/")) return true
  if (value.includes("/")) return true
  return /\.[A-Za-z0-9]+$/.test(value)
}

function resolveSkillReference(skillFile: string, reference: string) {
  if (reference.startsWith("~/")) return path.join(os.homedir(), reference.slice(2))
  if (path.isAbsolute(reference)) return path.normalize(reference)
  return path.resolve(path.dirname(skillFile), reference)
}

function displayPathForReference(reference: string, resolvedPath: string, skillFile: string) {
  if (reference.startsWith("~/") || path.isAbsolute(reference)) return reference
  return path.relative(path.dirname(skillFile), resolvedPath).replace(/\\/g, "/") || "."
}

async function classifyArtifact(resolvedPath: string): Promise<SkillArtifact["kind"]> {
  try {
    const info = await stat(resolvedPath)
    if (info.isDirectory()) return "directory"
    return "file"
  } catch {
    return "missing"
  }
}

async function extractSkillArtifacts(skillFile: string, content: string): Promise<SkillArtifact[]> {
  const candidates = [...extractMarkdownLinks(content), ...extractInlineCodePaths(content)]
    .sort((left, right) => left.offset - right.offset)
  const seen = new Set<string>()
  const artifacts: SkillArtifact[] = []
  for (const candidate of candidates) {
    if (!looksLikeLocalPathCandidate(candidate.reference)) continue
    const resolvedPath = resolveSkillReference(skillFile, candidate.reference)
    const dedupeKey = resolvedPath.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    artifacts.push({
      reference: candidate.reference,
      path: displayPathForReference(candidate.reference, resolvedPath, skillFile),
      resolvedPath,
      kind: await classifyArtifact(resolvedPath),
      source: candidate.source,
    })
  }
  return artifacts
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
  private diagnosticCache?: SkillDiagnostic[]

  constructor(projectRoot: string, roots?: string[]) {
    this.projectRoot = projectRoot
    this.roots = roots ?? [
      path.join(easycodeDir(projectRoot), "skills"),
      path.join(os.homedir(), ".easycode", "skills"),
    ]
  }

  async available() {
    if (!this.cache) {
      const files = (await Promise.all(this.roots.map(skillFiles))).flat()
      const seenNames = new Map<string, string[]>() // name -> [file, loc]
      const skills: SkillInfo[] = []
      const diagnostics: SkillDiagnostic[] = []
      for (const file of files) {
        const text = await Bun.file(file).text().catch(() => undefined)
        if (text === undefined) {
          diagnostics.push({ code: "read_failed", location: file, message: `Could not read skill file: ${file}` })
          continue
        }
        const parsed = parseFrontmatter(text)
        const name = parsed.data.get("name")
        const description = parsed.data.get("description")
        if (!name || !description) {
          diagnostics.push({
            code: "missing_required_frontmatter",
            location: file,
            message: `Skill file is missing required frontmatter: ${[!name ? "name" : "", !description ? "description" : ""].filter(Boolean).join(", ")}`,
          })
          continue
        }
        const id = path.relative(this.projectRoot, file).replace(/\\/g, "/")
        // Dedup by id (silently skip if the same id appears twice)
        if (skills.some((s) => s.id === id)) continue
        // Track duplicate names for warning (last unique id wins)
        const prev = seenNames.get(name)
        if (prev) prev.push(id)
        else seenNames.set(name, [id])
        skills.push({ id, name, description, location: file })
      }
      for (const [name, ids] of seenNames) {
        if (ids.length > 1) {
          diagnostics.push({
            code: "duplicate_name",
            name,
            ids,
            message: `Multiple skills share the name '${name}': ${ids.join(", ")}`,
          })
        }
      }
      this.cache = skills.sort((left, right) => left.name.localeCompare(right.name))
      this.diagnosticCache = diagnostics
    }
    return this.cache.map((skill) => ({ ...skill, content: undefined }))
  }

  async diagnostics() {
    await this.available()
    return (this.diagnosticCache ?? []).map((diagnostic) => diagnostic.ids ? { ...diagnostic, ids: [...diagnostic.ids] } : { ...diagnostic })
  }

  async load(nameOrId: string) {
    const skills = await this.available()
    // Try exact id match first, then exact name match (backward compat)
    const skill = skills.find((item) => item.id === nameOrId || item.name === nameOrId)
    if (!skill) return undefined
    const text = await Bun.file(skill.location).text().catch(() => undefined)
    if (text === undefined) return undefined
    const parsed = parseFrontmatter(text)
    return { ...skill, content: parsed.content, artifacts: await extractSkillArtifacts(skill.location, parsed.content) }
  }
}
