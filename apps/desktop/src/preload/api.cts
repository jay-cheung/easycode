import type { DesktopApi, DesktopDeleteSessionResult, DesktopFileSelection, DesktopGoalStatusResult, DesktopListSessionsResult, DesktopListSkillsResult, DesktopPermissionMode, DesktopPlanStatusResult, DesktopProviderListResult, DesktopProviderReadiness, DesktopProviderSetup, DesktopProviderSetupResult, DesktopRunMode, DesktopSettings, DesktopSettingsPatch, DesktopSidecarStatus, DesktopSlashCommandResult, DesktopWorkspaceStatus, SidecarFrame } from "../shared/protocol.js"

export type DesktopIpcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, frame: SidecarFrame) => void): void
  off(channel: string, listener: (event: unknown, frame: SidecarFrame) => void): void
}

export function createDesktopApi(ipcRenderer: DesktopIpcRenderer): DesktopApi {
  const invoke = <T,>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>
  return {
    settings: () => invoke<DesktopSettings>("settings:get"),
    updateSettings: (settings: Partial<DesktopSettings>) => invoke<DesktopSettings>("settings:update", settings),
    initialize: () => invoke("sidecar:initialize"),
    listProviders: () => invoke<DesktopProviderListResult>("sidecar:listProviders"),
    getProviderReadiness: () => invoke<DesktopProviderReadiness>("sidecar:getProviderReadiness"),
    configureProvider: (input: DesktopProviderSetup) => invoke<DesktopProviderSetupResult>("desktop:configureProvider", input),
    listSkills: () => invoke<DesktopListSkillsResult>("sidecar:listSkills"),
    listSessions: () => invoke<DesktopListSessionsResult>("sidecar:listSessions"),
    loadSession: (session: string) => invoke("sidecar:loadSession", session),
    deleteSession: (session: string) => invoke<DesktopDeleteSessionResult>("sidecar:deleteSession", session),
    getGoalStatus: (session?: string) => invoke<DesktopGoalStatusResult>("sidecar:getGoalStatus", session),
    pauseGoal: (session?: string) => invoke("sidecar:pauseGoal", session),
    resumeGoal: (session?: string) => invoke("sidecar:resumeGoal", session),
    clearGoal: (session?: string) => invoke("sidecar:clearGoal", session),
    getPlanStatus: (session?: string) => invoke<DesktopPlanStatusResult>("sidecar:getPlanStatus", session),
    clearPlan: (session?: string) => invoke("sidecar:clearPlan", session),
    updateSidecarSettings: (settings: DesktopSettingsPatch) => invoke<{ settings: DesktopSettings }>("sidecar:updateSettings", settings),
    pickWorkspace: () => invoke<string | undefined>("desktop:pickWorkspace"),
    pickFiles: () => invoke<DesktopFileSelection[]>("desktop:pickFiles"),
    showWorkspace: (workspaceRoot?: string) => invoke<{ opened: boolean }>("desktop:showWorkspace", workspaceRoot),
    openWorkspaceFile: (filePath: string) => invoke<{ opened: boolean; path: string }>("desktop:openWorkspaceFile", filePath),
    openWorkspaceChanges: () => invoke<{ opened: boolean; path: string }>("desktop:openWorkspaceChanges"),
    removeWorkspaceSidecar: (workspaceRoot: string) => invoke<{ stopped: boolean }>("desktop:removeWorkspaceSidecar", workspaceRoot),
    showSidecar: () => invoke<{ opened: boolean }>("desktop:showSidecar"),
    sidecarStatus: () => invoke<DesktopSidecarStatus>("desktop:sidecarStatus"),
    workspaceStatus: () => invoke<DesktopWorkspaceStatus>("desktop:workspaceStatus"),
    executeSlashCommand: (text: string, pendingImages?: number, pendingFiles?: number) => invoke<DesktopSlashCommandResult>("sidecar:executeSlashCommand", text, pendingImages, pendingFiles),
    runPrompt: (text: string, mode?: DesktopRunMode, images?: string[], permissionMode?: DesktopPermissionMode, files?: string[]) => invoke("sidecar:runPrompt", text, mode, images, permissionMode, files),
    cancelRun: () => invoke("sidecar:cancelRun"),
    replyPermission: (requestId: string, reply: "once" | "always" | "reject") => invoke("sidecar:replyPermission", requestId, reply),
    replyPlan: (runId: string, action: "approve" | "reject" | "edit" | "new_prompt", text?: string) => invoke("sidecar:replyPlan", runId, action, text),
    onSidecarEvent: (listener: (frame: SidecarFrame) => void) => {
      const wrapped = (_event: unknown, frame: SidecarFrame) => listener(frame)
      ipcRenderer.on("sidecar:event", wrapped)
      return () => ipcRenderer.off("sidecar:event", wrapped)
    },
  }
}
