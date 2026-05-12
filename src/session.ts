import path from "node:path"
import { mkdir } from "node:fs/promises"
import { ContextManager, type ContextManagerLike } from "./context"
import { redactProtectedMessages, validProviderMessageSuffix, type Message } from "./message"

export type SessionData = {
  id: string
  messages: Message[]
  summary?: string
  updatedAt: number
}

export class SessionStore {
  readonly dir: string

  constructor(root: string) {
    this.dir = path.join(root, ".easycode", "sessions")
  }

  async load(id: string) {
    const file = Bun.file(this.filePath(id))
    if (!(await file.exists())) return undefined
    return JSON.parse(await file.text()) as SessionData
  }

  async save(id: string, context: ContextManagerLike) {
    await mkdir(this.dir, { recursive: true })
    const messages = context.state.summary ? validProviderMessageSuffix(context.state.messages.slice(-context.preserveRecentMessages)) : context.state.messages
    const data: SessionData = {
      id,
      messages: redactProtectedMessages(messages),
      summary: context.state.summary,
      updatedAt: Date.now(),
    }
    await Bun.write(this.filePath(id), `${JSON.stringify(data, null, 2)}\n`)
  }

  async context(id: string) {
    const context = new ContextManager()
    const session = await this.load(id)
    if (!session) return context
    const messages = session.summary ? validProviderMessageSuffix(session.messages.slice(-context.preserveRecentMessages)) : session.messages
    for (const message of redactProtectedMessages(messages)) context.add(message)
    context.state.summary = session.summary
    context.state.tokenEstimate = context.estimate(context.state.messages) + Math.ceil((context.state.summary ?? "").length / 4)
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
