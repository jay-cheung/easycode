const { contextBridge, ipcRenderer } = require("electron")

type SidecarFrame = unknown
type DesktopApi = {
  settings: () => Promise<unknown>
  updateSettings: (settings: unknown) => Promise<unknown>
  initialize: () => Promise<unknown>
  listSessions: () => Promise<unknown>
  runPrompt: (text: string) => Promise<unknown>
  cancelRun: () => Promise<unknown>
  replyPermission: (requestId: string, reply: string) => Promise<unknown>
  replyPlan: (runId: string, action: string, text?: string) => Promise<unknown>
  onSidecarEvent: (listener: (frame: SidecarFrame) => void) => () => void
}

const api: DesktopApi = {
  settings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  initialize: () => ipcRenderer.invoke("sidecar:initialize"),
  listSessions: () => ipcRenderer.invoke("sidecar:listSessions"),
  runPrompt: (text) => ipcRenderer.invoke("sidecar:runPrompt", text),
  cancelRun: () => ipcRenderer.invoke("sidecar:cancelRun"),
  replyPermission: (requestId, reply) => ipcRenderer.invoke("sidecar:replyPermission", requestId, reply),
  replyPlan: (runId, action, text) => ipcRenderer.invoke("sidecar:replyPlan", runId, action, text),
  onSidecarEvent: (listener) => {
    const wrapped = (_event: unknown, frame: SidecarFrame) => listener(frame)
    ipcRenderer.on("sidecar:event", wrapped)
    return () => ipcRenderer.off("sidecar:event", wrapped)
  },
}

contextBridge.exposeInMainWorld("easycode", api)
