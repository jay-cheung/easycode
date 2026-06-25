import { describe, expect, test } from "bun:test"
import { desktopSessionSelectionStorageKey, readDesktopSessionSelection, resolveStartupSession, resolveStartupWorkspace, writeDesktopSessionSelection } from "../../apps/desktop/src/renderer/session-selection-state"

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(desktopSessionSelectionStorageKey, initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    value: () => values.get(desktopSessionSelectionStorageKey),
  }
}

describe("desktop session selection state", () => {
  test("round-trips the selected workspace and session through local storage", () => {
    const storage = memoryStorage()
    writeDesktopSessionSelection({ workspaceRoot: "/repo/a", session: "review" }, storage)

    expect(readDesktopSessionSelection(storage)).toEqual({ workspaceRoot: "/repo/a", session: "review" })
  })

  test("drops malformed selection values", () => {
    const storage = memoryStorage("{bad json")

    expect(readDesktopSessionSelection(storage)).toBeUndefined()
    expect(storage.value()).toBeUndefined()
  })

  test("uses the remembered workspace first, then falls back to the first workspace", () => {
    expect(resolveStartupWorkspace(["/repo/a", "/repo/b"], { workspaceRoot: "/repo/b", session: "s2" })).toBe("/repo/b")
    expect(resolveStartupWorkspace(["/repo/a", "/repo/b"], { workspaceRoot: "/missing", session: "s2" })).toBe("/repo/a")
  })

  test("uses the remembered session when it belongs to the selected workspace, otherwise the first session", () => {
    const sessions = [
      { id: "first", file: "first.json", messageCount: 1, updatedAt: 1 },
      { id: "second", file: "second.json", messageCount: 1, updatedAt: 2 },
    ]

    expect(resolveStartupSession(sessions, { workspaceRoot: "/repo/a", session: "second" }, "/repo/a", "default")).toBe("second")
    expect(resolveStartupSession(sessions, { workspaceRoot: "/repo/b", session: "second" }, "/repo/a", "default")).toBe("first")
    expect(resolveStartupSession([], undefined, "/repo/a", "default")).toBe("default")
  })
})
