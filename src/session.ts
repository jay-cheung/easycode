import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import { easycodeDir } from "./easycode-path"
import { ContextManager, type ContextLedger, type ContextManagerLike } from "./context"
import { redactProtectedMessages, truncateLargeMessageOutputs, type Message } from "./message"
import { normalizeSessionSettings, type SessionSettings } from "./settings"
import { persistedSessionMessages } from "./session-tail"

export type SessionTokenUsage = {
  inputTokens: number
  outputTokens: number
  calls: number
}

export type SessionData = {
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

export class SessionStore {
  readonly dir: string

  constructor(root: string) {
    this.dir = path.join(easycodeDir(root), "sessions")
  }

  async load(id: string) {
    const file = Bun.file(this.filePath(id))
    if (!(await file.exists())) return undefined
    return JSON.parse(await file.text()) as SessionData
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
        const data = JSON.parse(await Bun.file(path.join(this.dir, entry)).text()) as Partial<SessionData>
        if (typeof data.id !== "string" || !data.id.trim()) continue
        sessions.push({
          id: data.id,
          file: entry,
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
          updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
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
      id,
      messages: truncateLargeMessageOutputs(redactProtectedMessages(messages)),
      summary: context.state.summary,
      ledger: context.state.ledger,
      ...(settings ? { settings: normalizeSessionSettings(settings, settings.provider) } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      updatedAt: Date.now(),
    }
    await Bun.write(this.filePath(id), `${JSON.stringify(data, null, 2)}\n`)
  }

  async settings(id: string, fallbackProvider = "fake") {
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
    context.setLedger(session.ledger)
    return context
  }

  private filePath(id: string) {
    return path.join(this.dir, `${safeSessionID(id)}.json`)
  }
}

export function safeSessionID(id: string) {
  const safe = id.trim().replace(/[^A-Za-z0-9_.-]/g, "_")
  if (!safe) throw new Error("Session id cannot be empty")
  return safe
}
