import type { DesktopSessionSummary } from "../shared/protocol.js"

export type DesktopSessionSelection = {
  workspaceRoot: string
  session: string
}

export const desktopSessionSelectionStorageKey = "easycode.desktop.selectedSession.v1"

type SelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function readDesktopSessionSelection(storage: SelectionStorage = window.localStorage): DesktopSessionSelection | undefined {
  try {
    const raw = storage.getItem(desktopSessionSelectionStorageKey)
    if (!raw) return undefined
    return normalizeSelection(JSON.parse(raw))
  } catch {
    storage.removeItem(desktopSessionSelectionStorageKey)
    return undefined
  }
}

export function writeDesktopSessionSelection(selection: DesktopSessionSelection, storage: SelectionStorage = window.localStorage) {
  const normalized = normalizeSelection(selection)
  if (!normalized) return
  storage.setItem(desktopSessionSelectionStorageKey, JSON.stringify(normalized))
}

export function resolveStartupWorkspace(workspaceRoots: string[], selection: DesktopSessionSelection | undefined) {
  if (selection && workspaceRoots.includes(selection.workspaceRoot)) return selection.workspaceRoot
  return workspaceRoots[0]
}

export function resolveStartupSession(sessions: DesktopSessionSummary[], selection: DesktopSessionSelection | undefined, workspaceRoot: string | undefined, fallbackSession: string | undefined) {
  const rememberedSelection = selection
  if (rememberedSelection && rememberedSelection.workspaceRoot === workspaceRoot) {
    const rememberedSession = rememberedSelection.session
    if (sessions.some((session) => session.id === rememberedSession)) return rememberedSession
  }
  return sessions[0]?.id ?? fallbackSession
}

function normalizeSelection(value: unknown): DesktopSessionSelection | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const workspaceRoot = typeof record.workspaceRoot === "string" ? record.workspaceRoot.trim() : ""
  const session = typeof record.session === "string" ? record.session.trim() : ""
  if (!workspaceRoot || !session) return undefined
  return { workspaceRoot, session }
}
