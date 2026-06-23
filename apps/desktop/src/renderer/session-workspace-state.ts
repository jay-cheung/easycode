import type { DesktopSessionSummary } from "../shared/protocol.js"

export type WorkspaceRemovalPlan =
  | { type: "remove_inactive"; recentWorkspaces: string[] }
  | { type: "switch_active"; workspaceRoot: string; recentWorkspaces: string[]; session: "default" }
  | { type: "keep_last" }

export function truncateSessionTitle(title: string) {
  const characters = Array.from(title.trim())
  return characters.length > 10 ? `${characters.slice(0, 10).join("")}...` : characters.join("")
}

export function titleFromPrompt(text: string) {
  return truncateSessionTitle(text.replace(/\s+/g, " ").trim() || "New Chat")
}

export function sessionIdFromPrompt(text: string, now = new Date()) {
  const title = titleFromPrompt(text)
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  return `chat-${stamp}${ascii ? `-${ascii}` : ""}`
}

export function draftSessionId(now = new Date()) {
  return sessionIdFromPrompt("New Chat", now)
}

export function draftSessionPromptPlan(text: string, existingDraftSessionId: string | undefined, now = new Date()) {
  const title = titleFromPrompt(text)
  const session = existingDraftSessionId?.trim() || sessionIdFromPrompt(text, now)
  return { session, title }
}

export function upsertSessionPreview(current: DesktopSessionSummary[], session: string, title: string, now = Date.now()): DesktopSessionSummary[] {
  const existing = current.find((item) => item.id === session)
  const preview: DesktopSessionSummary = {
    id: session,
    file: existing?.file ?? "",
    messageCount: existing?.messageCount ?? 0,
    title,
    updatedAt: now,
  }
  if (!existing) return [preview, ...current]
  return current.map((item) => item.id === session ? preview : item)
}

export function removeSessionPreview(current: DesktopSessionSummary[], session: string): DesktopSessionSummary[] {
  return current.filter((item) => item.id !== session)
}

export function mergeSessionListPreservingOrder(current: DesktopSessionSummary[], incoming: DesktopSessionSummary[]) {
  if (current.length === 0) return incoming
  const incomingById = new Map(incoming.map((session) => [session.id, session]))
  const known = current.flatMap((session) => {
    const next = incomingById.get(session.id)
    return next ? [{ ...next, title: next.title ?? session.title }] : []
  })
  const knownIds = new Set(known.map((session) => session.id))
  const added = incoming.filter((session) => !knownIds.has(session.id))
  return [...known, ...added]
}

export function workspaceRoots(workspaceRoot: string | undefined, recentWorkspaces: string[] | undefined) {
  return unique([...(recentWorkspaces ?? []), workspaceRoot])
}

export function workspaceSwitchPatch(workspaceRoot: string) {
  return { workspaceRoot, session: "default" as const }
}

export function sessionSwitchSlashCommand(session: string) {
  return `/session switch ${session.trim()}`
}

export function planWorkspaceRemoval(currentWorkspace: string, recentWorkspaces: string[], targetWorkspace: string): WorkspaceRemovalPlan {
  const roots = workspaceRoots(currentWorkspace, recentWorkspaces)
  const remaining = roots.filter((root) => root !== targetWorkspace)
  if (targetWorkspace !== currentWorkspace) return { type: "remove_inactive", recentWorkspaces: remaining }
  const nextRoot = remaining[0]
  if (!nextRoot) return { type: "keep_last" }
  return { type: "switch_active", workspaceRoot: nextRoot, recentWorkspaces: remaining, session: "default" }
}

export function workspaceRemovalClearsDraft(plan: WorkspaceRemovalPlan) {
  return plan.type === "switch_active"
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))]
}
