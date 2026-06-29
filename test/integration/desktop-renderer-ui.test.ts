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

  test("keeps workspace menus hover-driven and tool calls grouped outside scroll-triggering state", async () => {
    const app = await Bun.file(path.join(repoRoot, "apps/desktop/src/renderer/App.tsx")).text()
    const css = await Bun.file(path.join(repoRoot, "apps/desktop/src/renderer/styles.css")).text()

    expect(app).toContain('className="workspace-menu-host"')
    expect(app).not.toContain("workspaceMenuOpen")
    expect(css).toContain(".workspace-menu-host::after")
    expect(css).toContain(".workspace-menu-host:hover .workspace-menu")
    expect(css).toContain(".workspace-menu-host:focus-within .workspace-menu")
    expect(app).toContain("firstDisplayUserTitle(items)")
    expect(app).toContain("isInternalGoalPrompt")
    expect(app).toContain("safeSessionTitle")
    expect(app).toContain('entries.push({ id: item.id, kind: "message", item: { ...item, text: safeSessionTitle(item.text) } })')
    expect(app).toContain("streamEntries.length === 0")
    expect(app).not.toContain('className="progress-dock"')
    expect(app).not.toContain('className="brand-row"')
    expect(app).toContain("groupStreamItems(items)")
    expect(app).toContain('kind: "assistantTurn"')
    expect(app).toContain("function AssistantTurn")
    expect(app).toContain("function ActivityGroup")
    expect(app).toContain("groupAssistantActivity(entry.parts)")
    expect(app).toContain("splitAssistantMessagePart")
    expect(app).toContain("function activitySummary")
    expect(app).toContain("<AssistantTurn copy={copy} key={entry.id} entry={entry} onOpenFile={openWorkspaceFileFromMessage} />")
    expect(app).toContain("isPlanControlTool(event.toolName)")
    expect(app).toContain("isGoalControlTool(event.toolName)")
    expect(app).toContain("if (isPlanControlTool(item.title) || isGoalControlTool(item.title)) continue")
    expect(app).toContain('className="composer-stack"')
    expect(app).toContain("<WorkspaceChangesBar copy={copy} goal={goal} planStatus={planStatus} status={workspaceStatus} onOpen={openWorkspaceChanges} />")
    expect(app).toContain("function ComposerDropdown")
    expect(app).toContain('className="panel-dropdown-trigger"')
    expect(app).not.toContain("function GoalProgress")
    expect(app).not.toContain("function PlanProgress")
    expect(app).toContain("function ToolGroup({ copy, tools }")
    expect(app).not.toContain("function ToolRow")
    expect(app).not.toContain("setItems: Dispatch<SetStateAction<ChatItem[]>>")
    expect(css).not.toContain(".goal-progress:hover .goal-popover")
    expect(css).not.toContain(".plan-progress:hover .plan-popover")
    expect(css).toContain(".workspace-plan-popover")
    expect(css).toContain(".composer-dropdown-menu")
    expect(css).toContain(".panel-dropdown-menu")
    expect(css).toContain("animation: railIn 0.18s ease-out")
    expect(css).toContain(".activity-group")
    expect(css).toContain(".activity-list")
  })
})
