export type DesktopSettings = {
  workspaceRoot: string
  sidecarPath?: string
  provider: string
  session: string
  recentWorkspaces: string[]
}

export type SidecarFrame =
  | { type: "event"; runId?: string; event: any }
  | { id: string; ok: true; result: any }
  | { id: string; ok: false; error: { code: string; message: string } }

export type DesktopApi = {
  settings(): Promise<DesktopSettings>
  updateSettings(settings: Partial<DesktopSettings>): Promise<DesktopSettings>
  initialize(): Promise<any>
  listSessions(): Promise<any>
  runPrompt(text: string): Promise<any>
  cancelRun(): Promise<any>
  replyPermission(requestId: string, reply: "once" | "always" | "reject"): Promise<any>
  replyPlan(runId: string, action: "approve" | "reject" | "edit" | "new_prompt", text?: string): Promise<any>
  onSidecarEvent(listener: (frame: SidecarFrame) => void): () => void
}

declare global {
  interface Window {
    easycode: DesktopApi
  }
}
