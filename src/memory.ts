import path from "node:path"
import { mkdir } from "node:fs/promises"
import { easycodeDir } from "./easycode-path"

export type ProjectMemoryRecord = {
  id: string
  text: string
  tags: string[]
  source: "user" | "assistant" | "tool"
  createdAt: number
}

export type ProjectMemoryData = {
  version: 1
  records: ProjectMemoryRecord[]
}

export class ProjectMemoryStore {
  readonly filePath: string

  constructor(root: string) {
    this.filePath = path.join(easycodeDir(root), "memory.json")
  }

  async list() {
    return (await this.load()).records
  }

  async query(query: string, limit = 5) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const records = await this.list()
    return records
      .map((record) => ({ record, score: memoryScore(record, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.record.createdAt - left.record.createdAt)
      .slice(0, Math.max(1, Math.min(20, Math.round(limit))))
      .map((item) => item.record)
  }

  async add(input: { text: string; tags?: string[]; source?: ProjectMemoryRecord["source"] }) {
    const data = await this.load()
    const record: ProjectMemoryRecord = {
      id: `mem_${Date.now().toString(36)}_${data.records.length.toString(36)}`,
      text: sanitizeMemoryText(input.text),
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
      source: input.source ?? "assistant",
      createdAt: Date.now(),
    }
    data.records.push(record)
    await this.save(data)
    return record
  }

  private async load(): Promise<ProjectMemoryData> {
    const file = Bun.file(this.filePath)
    if (!(await file.exists())) return { version: 1, records: [] }
    const parsed = JSON.parse(await file.text()) as Partial<ProjectMemoryData>
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records.filter(isMemoryRecord) : [] }
  }

  private async save(data: ProjectMemoryData) {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await Bun.write(this.filePath, `${JSON.stringify(data, null, 2)}\n`)
  }
}

export function sanitizeMemoryText(text: string) {
  return text
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email-redacted]")
    .slice(0, 1200)
}

function memoryScore(record: ProjectMemoryRecord, terms: string[]) {
  if (terms.length === 0) return 1
  const haystack = `${record.text} ${record.tags.join(" ")}`.toLowerCase()
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0)
}

function isMemoryRecord(value: unknown): value is ProjectMemoryRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<ProjectMemoryRecord>
  return typeof record.id === "string" && typeof record.text === "string" && Array.isArray(record.tags) && typeof record.createdAt === "number"
}
