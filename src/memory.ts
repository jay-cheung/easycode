import path from "node:path"
import { mkdir } from "node:fs/promises"
import { easycodeDir } from "./easycode-path"

export type ProjectMemoryKind = "note" | "session_archive" | "preference" | "repo_fact" | "failure_pattern" | "successful_workflow" | "task_state"
export type ProjectMemoryPromotableKind = Exclude<ProjectMemoryKind, "note" | "session_archive">

export type ProjectMemoryScope = {
  files?: string[]
  symbols?: string[]
  topics?: string[]
}

export type ProjectMemoryRecord = {
  id: string
  kind: ProjectMemoryKind
  text: string
  tags: string[]
  scope?: ProjectMemoryScope
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

  async query(query: string, limit = 5, options: { kinds?: ProjectMemoryKind[] } = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const kinds = options.kinds ? new Set(options.kinds) : undefined
    const records = await this.list()
    return records
      .filter((record) => !kinds || kinds.has(record.kind))
      .map((record) => ({ record, score: memoryScore(record, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.record.createdAt - left.record.createdAt)
      .slice(0, Math.max(1, Math.min(20, Math.round(limit))))
      .map((item) => item.record)
  }

  async add(input: { text: string; tags?: string[]; source?: ProjectMemoryRecord["source"]; kind?: ProjectMemoryKind; scope?: ProjectMemoryScope }) {
    const data = await this.load()
    const record: ProjectMemoryRecord = {
      id: `mem_${Date.now().toString(36)}_${data.records.length.toString(36)}`,
      kind: input.kind ?? "note",
      text: sanitizeMemoryText(input.text),
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
      ...(normalizeScope(input.scope) ? { scope: normalizeScope(input.scope) } : {}),
      source: input.source ?? "assistant",
      createdAt: Date.now(),
    }
    data.records.push(record)
    await this.save(data)
    return record
  }

  async promote(input: { text: string; kind: ProjectMemoryPromotableKind; tags?: string[]; source?: ProjectMemoryRecord["source"]; scope?: ProjectMemoryScope }) {
    const normalized = compactMemoryPromotionText(input.text)
    if (!normalized) throw new Error("memory_promote requires non-empty text")
    if (normalized.length > 400) throw new Error("memory_promote text must stay under 400 characters; store only the durable lesson")
    return this.add({
      text: normalized,
      kind: input.kind,
      tags: input.tags,
      scope: input.scope,
      source: input.source,
    })
  }

  private async load(): Promise<ProjectMemoryData> {
    const file = Bun.file(this.filePath)
    if (!(await file.exists())) return { version: 1, records: [] }
    const parsed = JSON.parse(await file.text()) as Partial<ProjectMemoryData>
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records.flatMap(parseMemoryRecord) : [] }
  }

  private async save(data: ProjectMemoryData) {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await Bun.write(this.filePath, `${JSON.stringify(data, null, 2)}\n`)
  }
}

export function formatProjectMemoryRecord(record: ProjectMemoryRecord) {
  const scope = formatScope(record.scope)
  const tags = record.tags.length > 0 ? ` tags=${record.tags.join(",")}` : ""
  return `${record.id} [${record.kind}]${tags}${scope ? ` scope=${scope}` : ""}: ${record.text}`
}

export function renderProjectMemoryRecall(records: ProjectMemoryRecord[], query: string) {
  const lines = ["<project_memory_recall>", `query: ${query}`]
  for (const record of records) lines.push(`- ${formatProjectMemoryRecord(record)}`)
  lines.push("</project_memory_recall>")
  return lines.join("\n")
}

export function shouldAutoRecallProjectMemory(prompt: string) {
  return /\b(continue|resume|previous|prior|last time|again|before)\b|继续|之前|上次|刚才|刚刚|恢复/i.test(prompt)
}

export function sanitizeMemoryText(text: string) {
  return text
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email-redacted]")
    .slice(0, 1200)
}

export function compactMemoryPromotionText(text: string) {
  return sanitizeMemoryText(text).replace(/\s+/g, " ").trim()
}

function memoryScore(record: ProjectMemoryRecord, terms: string[]) {
  if (terms.length === 0) return 1
  const haystack = `${record.kind} ${record.text} ${record.tags.join(" ")} ${record.scope?.files?.join(" ") ?? ""} ${record.scope?.symbols?.join(" ") ?? ""} ${record.scope?.topics?.join(" ") ?? ""}`.toLowerCase()
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0)
}

function parseMemoryRecord(value: unknown): ProjectMemoryRecord[] {
  if (!value || typeof value !== "object") return []
  const record = value as Partial<ProjectMemoryRecord>
  if (typeof record.id !== "string" || typeof record.text !== "string" || !Array.isArray(record.tags) || typeof record.createdAt !== "number") return []
  const normalized: ProjectMemoryRecord = {
    id: record.id,
    kind: isProjectMemoryKind(record.kind) ? record.kind : "note",
    text: sanitizeMemoryText(record.text),
    tags: [...new Set(record.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))],
    ...(normalizeScope(record.scope) ? { scope: normalizeScope(record.scope) } : {}),
    source: record.source === "user" || record.source === "assistant" || record.source === "tool" ? record.source : "assistant",
    createdAt: record.createdAt,
  }
  return [normalized]
}

function normalizeScope(scope: unknown): ProjectMemoryScope | undefined {
  if (!scope || typeof scope !== "object") return undefined
  const value = scope as Partial<ProjectMemoryScope>
  const normalized: ProjectMemoryScope = {}
  const files = normalizeStringList(value.files)
  const symbols = normalizeStringList(value.symbols)
  const topics = normalizeStringList(value.topics)
  if (files.length > 0) normalized.files = files
  if (symbols.length > 0) normalized.symbols = symbols
  if (topics.length > 0) normalized.topics = topics
  return normalized.files || normalized.symbols || normalized.topics ? normalized : undefined
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
}

function formatScope(scope: ProjectMemoryScope | undefined) {
  if (!scope) return ""
  const parts = [
    ...(scope.files?.length ? [`files=${scope.files.join(",")}`] : []),
    ...(scope.symbols?.length ? [`symbols=${scope.symbols.join(",")}`] : []),
    ...(scope.topics?.length ? [`topics=${scope.topics.join(",")}`] : []),
  ]
  return parts.join("; ")
}

function isProjectMemoryKind(value: unknown): value is ProjectMemoryKind {
  return value === "note" ||
    value === "session_archive" ||
    value === "preference" ||
    value === "repo_fact" ||
    value === "failure_pattern" ||
    value === "successful_workflow" ||
    value === "task_state"
}

export function isPromotableMemoryKind(value: unknown): value is ProjectMemoryPromotableKind {
  return value === "preference" ||
    value === "repo_fact" ||
    value === "failure_pattern" ||
    value === "successful_workflow" ||
    value === "task_state"
}
