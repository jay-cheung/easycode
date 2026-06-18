import path from "node:path"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { easycodeDir } from "../easycode-path"
import { stripPlanLedger } from "../agent/planner"
import { ContextManager, type ContextLedger, type ContextManagerLike } from "../context"
import { stripGoalLedger } from "../goal"
import { ProjectMemoryStore } from "../memory"
import { redactProtectedMessages, truncateLargeMessageOutputs, type Message } from "../message"
import { planStoreDir } from "../plans"
import { defaultProviderName, normalizeSessionSettings, type SessionSettings } from "../settings"
import { backupPath, loadJsonWithBackup, writeJsonAtomically } from "../storage"
import { persistedSessionMessages } from "./session-tail"

export const sessionDataVersion = 1

export type SessionTokenUsage = {
  inputTokens: number
  outputTokens: number
  calls: number
  subagentInputTokens: number
  subagentOutputTokens: number
  subagentCalls: number
  subagentCacheHitTokens: number
  subagentCacheMissTokens: number
}

export type SessionData = {
  version: typeof sessionDataVersion
  id: string
  messages: Message[]
  summary?: string
  ledger?: ContextLedger
  settings?: SessionSettings
  tokenUsage?: SessionTokenUsage
  updatedAt: number
}

export type SessionSummary = {
  id: string
  file: string
  messageCount: number
  updatedAt: number
}

export type SessionDeleteResult = {
  existed: boolean
  deletedPaths: string[]
  archivedMemoryId?: string
}

export class SessionStore {
  readonly root: string
  readonly dir: string

  constructor(root: string) {
    this.root = root
    this.dir = path.join(easycodeDir(root), "sessions")
  }

  async load(id: string) {
    const loaded = await loadJsonWithBackup<Partial<SessionData> & { version?: unknown }>(this.filePath(id))
    if (!loaded.data) return undefined
    return normalizeSessionData(loaded.data)
  }

  async list(): Promise<SessionSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
      throw error
    }
    const sessions: SessionSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      try {
        const data = normalizeSessionData(JSON.parse(await Bun.file(path.join(this.dir, entry)).text()) as Partial<SessionData> & { version?: unknown })
        if (!data) continue
        sessions.push({
          id: data.id,
          file: entry,
          messageCount: data.messages.length,
          updatedAt: data.updatedAt,
        })
      } catch {
        continue
      }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  }

  async save(id: string, context: ContextManagerLike, settings?: SessionSettings, tokenUsage?: SessionTokenUsage) {
    await mkdir(this.dir, { recursive: true })
    const messages = context.state.summary
      ? persistedSessionMessages(context.state.messages, context.preserveRecentUserTurns, context.compactPreserveTokens)
      : context.state.messages
    const data: SessionData = {
      version: sessionDataVersion,
      id,
      messages: truncateLargeMessageOutputs(redactProtectedMessages(messages)),
      summary: context.state.summary,
      ledger: context.state.ledger,
      ...(settings ? { settings: normalizeSessionSettings(settings, settings.provider) } : {}),
      ...(tokenUsage ? { tokenUsage: normalizeSessionTokenUsage(tokenUsage) } : {}),
      updatedAt: Date.now(),
    }
    await writeJsonAtomically(this.filePath(id), data)
  }

  async settings(id: string, fallbackProvider = defaultProviderName) {
    return normalizeSessionSettings((await this.load(id))?.settings, fallbackProvider)
  }

  async context(id: string) {
    const context = new ContextManager()
    const session = await this.load(id)
    if (!session) return context
    const messages = session.summary
      ? persistedSessionMessages(session.messages, context.preserveRecentUserTurns, context.compactPreserveTokens)
      : session.messages
    for (const message of truncateLargeMessageOutputs(redactProtectedMessages(messages))) context.add(message)
    context.state.summary = session.summary
    context.setLedger(stripPlanLedger(stripGoalLedger(session.ledger)))
    return context
  }

  async delete(id: string): Promise<SessionDeleteResult> {
    const session = await this.load(id)
    if (!session) return { existed: false, deletedPaths: [] }

    const archived = await new ProjectMemoryStore(this.root).add({
      text: archivedSessionText(session),
      tags: archivedSessionTags(session),
      kind: "session_archive",
      scope: { topics: ["session_archive", safeSessionID(session.id)] },
      source: "assistant",
    })

    const targets = sessionDeletePaths(this.root, id)
    const deletedPaths: string[] = []
    for (const target of targets) {
      const deleted = await removeIfExists(target.path, target.directory)
      if (deleted) deletedPaths.push(target.path)
    }

    return {
      existed: true,
      deletedPaths,
      archivedMemoryId: archived.id,
    }
  }

  private filePath(id: string) {
    return path.join(this.dir, `${safeSessionID(id)}.json`)
  }
}

export function normalizeSessionTokenUsage(input: Partial<SessionTokenUsage> | undefined): SessionTokenUsage {
  return {
    inputTokens: normalizeUsageNumber(input?.inputTokens),
    outputTokens: normalizeUsageNumber(input?.outputTokens),
    calls: normalizeUsageNumber(input?.calls),
    subagentInputTokens: normalizeUsageNumber(input?.subagentInputTokens),
    subagentOutputTokens: normalizeUsageNumber(input?.subagentOutputTokens),
    subagentCalls: normalizeUsageNumber(input?.subagentCalls),
    subagentCacheHitTokens: normalizeUsageNumber(input?.subagentCacheHitTokens),
    subagentCacheMissTokens: normalizeUsageNumber(input?.subagentCacheMissTokens),
  }
}

export function safeSessionID(id: string) {
  const safe = id.trim().replace(/[^A-Za-z0-9_.-]/g, "_")
  if (!safe) throw new Error("Session id cannot be empty")
  return safe
}

function sessionDeletePaths(root: string, id: string) {
  const safe = safeSessionID(id)
  const base = easycodeDir(root)
  const sessionPath = path.join(base, "sessions", `${safe}.json`)
  return [
    { path: sessionPath, directory: false },
    { path: backupPath(sessionPath), directory: false },
    { path: path.join(base, "logs", "sessions", `${safe}.jsonl`), directory: false },
    { path: path.join(base, "logs", "sessions", `${safe}.txt`), directory: false },
    { path: path.join(base, "logs", "sessions", `${safe}.subagents.jsonl`), directory: false },
    { path: path.join(base, "logs", "sessions", `${safe}.subagents.txt`), directory: false },
    { path: planStoreDir(root, id), directory: true },
  ]
}

async function removeIfExists(targetPath: string, directory: boolean) {
  try {
    const info = await stat(targetPath)
    if (directory && !info.isDirectory()) return false
    if (!directory && !info.isFile()) return false
    await rm(targetPath, { recursive: directory, force: true })
    return true
  } catch {
    return false
  }
}

function archivedSessionTags(session: SessionData) {
  const tags = ["session", "archive", "deleted_session", safeSessionID(session.id)]
  if (session.settings?.provider) tags.push(`provider:${session.settings.provider}`)
  if (session.settings?.language) tags.push(`language:${session.settings.language}`)
  return tags
}

function archivedSessionText(session: SessionData) {
  const settings = session.settings ? normalizeSessionSettings(session.settings, session.settings.provider) : undefined
  const latestUser = latestMessageText(session.messages, "user")
  const latestAssistant = latestMessageText(session.messages, "assistant")
  const pieces = [
    `Deleted session "${session.id}".`,
    `messages=${session.messages.length}.`,
    `updatedAt=${new Date(session.updatedAt).toISOString()}.`,
    settings ? `provider=${settings.provider}. language=${settings.language}. thinking=${settings.thinking ? "on" : "off"}. effort=${settings.effort}.` : undefined,
    session.summary ? `summary=${session.summary}` : undefined,
    latestUser ? `latest_user=${latestUser}` : undefined,
    latestAssistant ? `latest_assistant=${latestAssistant}` : undefined,
  ]
  return pieces.filter(Boolean).join(" ")
}

function latestMessageText(messages: Message[], role: Message["role"]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== role) continue
    const text = message.parts
      .flatMap((part) => {
        if (part.type === "text") return [part.text]
        if (part.type === "tool_result") return [part.output]
        return []
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text.slice(0, 280)
  }
  return undefined
}

function normalizeUsageNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function normalizeSessionData(input: Partial<SessionData> & { version?: unknown }): SessionData | undefined {
  if (input.version !== undefined && input.version !== sessionDataVersion) return undefined
  if (typeof input.id !== "string" || !input.id.trim()) return undefined
  if (!Array.isArray(input.messages)) return undefined
  return {
    version: sessionDataVersion,
    id: input.id,
    messages: input.messages,
    ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
    ...(input.ledger ? { ledger: input.ledger } : {}),
    ...(input.settings ? { settings: normalizeSessionSettings(input.settings, input.settings.provider) } : {}),
    ...(input.tokenUsage ? { tokenUsage: normalizeSessionTokenUsage(input.tokenUsage) } : {}),
    updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  }
}
