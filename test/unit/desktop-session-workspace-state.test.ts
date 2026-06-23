import { describe, expect, test } from "bun:test"
import { draftSessionId, draftSessionPromptPlan, mergeSessionListPreservingOrder, planWorkspaceRemoval, removeSessionPreview, sessionIdFromPrompt, sessionSwitchSlashCommand, titleFromPrompt, truncateSessionTitle, upsertSessionPreview, workspaceRemovalClearsDraft, workspaceRoots, workspaceSwitchPatch } from "../../apps/desktop/src/renderer/session-workspace-state"

describe("desktop session and workspace state", () => {
  test("uses the first prompt text as a compact session title", () => {
    expect(titleFromPrompt("hello")).toBe("hello")
    expect(titleFromPrompt("  explain   cashier flow now  ")).toBe("explain ca...")
    expect(titleFromPrompt("解释 Price Action")).toBe("解释 Price A...")
    expect(truncateSessionTitle("1234567890")).toBe("1234567890")
    expect(truncateSessionTitle("12345678901")).toBe("1234567890...")
  })

  test("builds deterministic session ids from compact prompt titles", () => {
    const now = new Date("2026-06-22T06:00:00.000Z")
    expect(sessionIdFromPrompt("Explain cashier flow now", now)).toBe("chat-2026-06-22T06-00-00-000Z-explain-ca")
    expect(sessionIdFromPrompt("解释收银台流程", now)).toBe("chat-2026-06-22T06-00-00-000Z")
    expect(draftSessionId(now)).toBe("chat-2026-06-22T06-00-00-000Z-new-chat")
  })

  test("plans draft session promotion from the first submitted prompt", () => {
    const now = new Date("2026-06-22T06:00:00.000Z")
    expect(draftSessionPromptPlan("Explain cashier flow now", "draft-session", now)).toEqual({
      session: "draft-session",
      title: "Explain ca...",
    })
    expect(draftSessionPromptPlan("Explain cashier flow now", undefined, now)).toEqual({
      session: "chat-2026-06-22T06-00-00-000Z-explain-ca",
      title: "Explain ca...",
    })
  })

  test("adds and replaces local session previews without moving existing rows", () => {
    const first = upsertSessionPreview([], "draft-1", "New Chat", 1000)
    expect(first).toEqual([{ id: "draft-1", file: "", messageCount: 0, title: "New Chat", updatedAt: 1000 }])

    const second = upsertSessionPreview([{ id: "existing", file: "existing.json", messageCount: 2, title: "Existing", updatedAt: 900 }, ...first], "draft-1", "explain ca...", 1200)
    expect(second).toEqual([
      { id: "existing", file: "existing.json", messageCount: 2, title: "Existing", updatedAt: 900 },
      { id: "draft-1", file: "", messageCount: 0, title: "explain ca...", updatedAt: 1200 },
    ])
    expect(removeSessionPreview(second, "draft-1")).toEqual([{ id: "existing", file: "existing.json", messageCount: 2, title: "Existing", updatedAt: 900 }])
  })

  test("normalizes workspace roots without moving the active workspace to the front", () => {
    expect(workspaceRoots("/repo/a", ["/repo/b", "/repo/a", ""])).toEqual(["/repo/b", "/repo/a"])
    expect(workspaceRoots(undefined, ["/repo/b"])).toEqual(["/repo/b"])
    expect(workspaceRoots("/repo/c", ["/repo/b", "/repo/a"])).toEqual(["/repo/b", "/repo/a", "/repo/c"])
  })

  test("selecting workspaces or sessions keeps their current list position", () => {
    const roots = ["/repo/a", "/repo/b", "/repo/c"]
    expect(workspaceRoots("/repo/b", roots)).toEqual(roots)

    const sessions = [
      { id: "first", file: "first.json", messageCount: 1, title: "First", updatedAt: 100 },
      { id: "selected", file: "selected.json", messageCount: 2, title: "Selected", updatedAt: 200 },
      { id: "third", file: "third.json", messageCount: 3, title: "Third", updatedAt: 300 },
    ]
    expect(mergeSessionListPreservingOrder(sessions, [
      { id: "selected", file: "selected.json", messageCount: 4, title: "Selected updated", updatedAt: 400 },
      { id: "first", file: "first.json", messageCount: 1, title: "First", updatedAt: 100 },
      { id: "third", file: "third.json", messageCount: 3, title: "Third", updatedAt: 300 },
    ]).map((session) => session.id)).toEqual(["first", "selected", "third"])
  })

  test("merges refreshed sessions without reordering existing rows", () => {
    const current = [
      { id: "alpha", file: "alpha.json", messageCount: 1, title: "Alpha", updatedAt: 100 },
      { id: "beta", file: "beta.json", messageCount: 1, title: "Beta", updatedAt: 200 },
    ]
    const incoming = [
      { id: "beta", file: "beta.json", messageCount: 2, title: "Beta updated", updatedAt: 300 },
      { id: "alpha", file: "alpha.json", messageCount: 1, title: "Alpha", updatedAt: 100 },
      { id: "gamma", file: "gamma.json", messageCount: 0, title: "Gamma", updatedAt: 250 },
    ]

    expect(mergeSessionListPreservingOrder(current, incoming).map((session) => session.id)).toEqual(["alpha", "beta", "gamma"])
    expect(mergeSessionListPreservingOrder(current, incoming)[1]).toMatchObject({ id: "beta", title: "Beta updated", updatedAt: 300 })
  })

  test("keeps a local empty-session title until the sidecar has a real first prompt title", () => {
    const current = [
      { id: "draft", file: "", messageCount: 0, title: "New Chat", updatedAt: 100 },
    ]
    const emptySidecarRefresh = [
      { id: "draft", file: "draft.json", messageCount: 0, updatedAt: 200 },
    ]
    const titledSidecarRefresh = [
      { id: "draft", file: "draft.json", messageCount: 2, title: "Explain cashier flow now", updatedAt: 300 },
    ]

    expect(mergeSessionListPreservingOrder(current, emptySidecarRefresh)).toEqual([
      { id: "draft", file: "draft.json", messageCount: 0, title: "New Chat", updatedAt: 200 },
    ])
    expect(mergeSessionListPreservingOrder(current, titledSidecarRefresh)).toEqual([
      { id: "draft", file: "draft.json", messageCount: 2, title: "Explain cashier flow now", updatedAt: 300 },
    ])
  })

  test("switching workspaces always resets to default session", () => {
    expect(workspaceSwitchPatch("/repo/b")).toEqual({ workspaceRoot: "/repo/b", session: "default" })
  })

  test("session selection uses the shared slash switch command", () => {
    expect(sessionSwitchSlashCommand("scratch-session")).toBe("/session switch scratch-session")
    expect(sessionSwitchSlashCommand("  default  ")).toBe("/session switch default")
  })

  test("plans workspace removal without losing the active workspace unexpectedly", () => {
    const inactive = planWorkspaceRemoval("/repo/a", ["/repo/a", "/repo/b"], "/repo/b")
    const active = planWorkspaceRemoval("/repo/a", ["/repo/a", "/repo/b", "/repo/c"], "/repo/a")
    const last = planWorkspaceRemoval("/repo/a", ["/repo/a"], "/repo/a")

    expect(inactive).toEqual({
      type: "remove_inactive",
      recentWorkspaces: ["/repo/a"],
    })
    expect(active).toEqual({
      type: "switch_active",
      workspaceRoot: "/repo/b",
      recentWorkspaces: ["/repo/b", "/repo/c"],
      session: "default",
    })
    expect(last).toEqual({ type: "keep_last" })
    expect(workspaceRemovalClearsDraft(inactive)).toBe(false)
    expect(workspaceRemovalClearsDraft(active)).toBe(true)
    expect(workspaceRemovalClearsDraft(last)).toBe(false)
  })
})
