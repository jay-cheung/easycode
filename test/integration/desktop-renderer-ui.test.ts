import { describe, expect, test } from "bun:test"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")

describe("desktop renderer UI integration", () => {
  test("renders workspace-owned sessions without a duplicate session toolbar contract", async () => {
    const app = await Bun.file(path.join(repoRoot, "apps/desktop/src/renderer/App.tsx")).text()
    const css = await Bun.file(path.join(repoRoot, "apps/desktop/src/renderer/styles.css")).text()

    const workspaceSessionList = app.slice(
      app.indexOf('{active && <div className="workspace-session-list">'),
      app.indexOf("</SidebarGroup>"),
    )

    expect(workspaceSessionList).toContain("sessions.map")
    expect(workspaceSessionList).toContain("session-delete")
    expect(workspaceSessionList).not.toContain("session-subtitle")
    expect(workspaceSessionList).not.toContain("New session")
    expect(css).not.toContain(".session-subtitle")
  })

  test("keeps workspace menus hover-driven and tool toggles scroll-stable", async () => {
    const app = await Bun.file(path.join(repoRoot, "apps/desktop/src/renderer/App.tsx")).text()
    const css = await Bun.file(path.join(repoRoot, "apps/desktop/src/renderer/styles.css")).text()

    expect(app).toContain('className="workspace-menu-host"')
    expect(app).not.toContain("workspaceMenuOpen")
    expect(css).toContain(".workspace-menu-host:hover .workspace-menu")
    expect(css).toContain(".workspace-menu-host:focus-within .workspace-menu")
    expect(app).toContain("skipNextStreamScrollRef.current = true")
    expect(app).toContain("function ToolRow({ item, onToggle }")
    expect(app).not.toContain("setItems: Dispatch<SetStateAction<ChatItem[]>>")
  })
})
