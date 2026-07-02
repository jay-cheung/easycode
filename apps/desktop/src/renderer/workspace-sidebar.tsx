import type { DesktopSessionSummary, DesktopSettings } from "../shared/protocol.js"

type SidebarCopy = {
  localOnly: string
  newSession: string
  noSavedSessions: string
  removeWorkspace: string
  showInFinder: string
  workspaces: string
}

type WorkspaceSidebarProps = {
  copy: SidebarCopy
  draftSession: boolean
  draftSessionId?: string
  onAddWorkspace: () => void
  onDeleteSession: (session: string) => void
  onNewSession: () => void
  onRemoveWorkspace: (workspaceRoot: string) => void
  onSelectSession: (session: string) => void
  onSelectWorkspace: (workspaceRoot: string) => void
  onShowWorkspace: (workspaceRoot: string) => void
  running: boolean
  sessions: DesktopSessionSummary[]
  sessionTitle: (session: DesktopSessionSummary) => string
  settings?: DesktopSettings
  visibleWorkspaceRoots: string[]
  workspaceDisplayName: (workspaceRoot: string) => string
}

export function WorkspaceSidebar({
  copy,
  draftSession,
  draftSessionId,
  onAddWorkspace,
  onDeleteSession,
  onNewSession,
  onRemoveWorkspace,
  onSelectSession,
  onSelectWorkspace,
  onShowWorkspace,
  running,
  sessions,
  sessionTitle,
  settings,
  visibleWorkspaceRoots,
  workspaceDisplayName,
}: WorkspaceSidebarProps) {
  return <aside className="sidebar">
    <SidebarGroup title={copy.workspaces} action="+" onAction={onAddWorkspace}>
      <div className="workspace-list">
        {visibleWorkspaceRoots.map((root) => {
          const active = root === settings?.workspaceRoot
          return <div className={`workspace-card ${active ? "active" : ""}`} key={root}>
            <div className="workspace-head">
              <button className="workspace-select" onClick={() => onSelectWorkspace(root)} disabled={active} title={root}>
                <span className="workspace-title"><strong>{workspaceDisplayName(root)}</strong></span>
              </button>
              <button className="icon-button add-session-button" onClick={onNewSession} disabled={running || !active} aria-label={`${copy.newSession}: ${workspaceDisplayName(root)}`}>+</button>
              <div className="workspace-menu-host">
                <button className="icon-button workspace-more" aria-label={`${workspaceDisplayName(root)} menu`}><span>...</span></button>
                <div className="workspace-menu">
                  <button onClick={() => onShowWorkspace(root)}>{copy.showInFinder}</button>
                  <button onClick={() => onRemoveWorkspace(root)} disabled={running || visibleWorkspaceRoots.length <= 1} className="danger">{copy.removeWorkspace}</button>
                </div>
              </div>
            </div>
            {active && <div className="workspace-session-list">
              {sessions.length === 0 && <div className="empty-list">{copy.noSavedSessions}</div>}
              {sessions.map((session) => <div className={`thread-row ${(draftSession && session.id === draftSessionId) || (!draftSession && session.id === settings?.session) ? "active" : ""}`} key={session.id}>
                <button className="thread-select" onClick={() => onSelectSession(session.id)} disabled={running} title={session.title || session.id}>
                  <span>{sessionTitle(session)}</span>
                </button>
                <button className="session-delete" onClick={() => onDeleteSession(session.id)} disabled={running} aria-label={`Delete ${sessionTitle(session)}`}>×</button>
              </div>)}
            </div>}
          </div>
        })}
      </div>
    </SidebarGroup>
    <div className="sidebar-footer">
      <div><span className="status-dot green" />{copy.localOnly}</div>
    </div>
  </aside>
}

function SidebarGroup({ action, children, onAction, title }: { action?: string; children: React.ReactNode; onAction?: () => void; title: string }) {
  return <section className="sidebar-group"><div className="group-title"><span>{title}</span>{action && <button onClick={onAction}>{action}</button>}</div>{children}</section>
}
