import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import { easycodeDir } from "./easycode-path"
import { ContextManager, estimateMessages, splitRecentUserTurns, type ContextLedger, type ContextManagerLike } from "./context"
import { redactProtectedMessages, truncateLargeMessageOutputs, validProviderMessageSuffix, type Message } from "./message"
import { normalizeSessionSettings, type SessionSettings } from "./settings"

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

function persistedSessionMessages(messages: Message[], preserveRecentUserTurns: number, compactPreserveTokens: number) {
  const recent = splitRecentUserTurns(messages, preserveRecentUserTurns).recent
  return recentSessionMessageSuffix(recent, compactPreserveTokens)
}

function recentSessionMessageSuffix(messages: Message[], maxTokens = 3_000) {
  const userTurnStarts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []))
  if (userTurnStarts.length === 0) return greedySessionMessageSuffix(messages, maxTokens)

  const latestTurnStart = userTurnStarts[userTurnStarts.length - 1]
  const latestTurn = validProviderMessageSuffix(messages.slice(latestTurnStart))

  // For persisted sessions, prefer keeping the latest answered turn even when it
  // exceeds the preserve budget; otherwise restored sessions can replay an already
  // answered request because the summary lags behind the fresh tail.
  if (estimateMessages(latestTurn) > maxTokens) {
    return latestTurn.length > 1 ? latestTurn : validProviderMessageSuffix([messages[latestTurnStart]])
  }

  let preserved = latestTurn
  for (let index = userTurnStarts.length - 2; index >= 0; index -= 1) {
    const candidate = validProviderMessageSuffix(messages.slice(userTurnStarts[index]))
    if (estimateMessages(candidate) > maxTokens) break
    preserved = candidate
  }
  return preserved
}

function greedySessionMessageSuffix(messages: Message[], maxTokens: number) {
  const suffix: Message[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = validProviderMessageSuffix([messages[index], ...suffix])
    if (candidate.length === 0) {
      if (messages[index].role === "tool") suffix.unshift(messages[index])
      continue
    }
    if (estimateMessages(candidate) > maxTokens && suffix.length > 0) break
    suffix.unshift(messages[index])
  }
  return validProviderMessageSuffix(suffix)
}
