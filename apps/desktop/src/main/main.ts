import { app, BrowserWindow, ipcMain } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadSettings, saveSettings } from "./settings.js"
import { SidecarBridge } from "./sidecar.js"
import type { DesktopSettings } from "../shared/protocol.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
let bridge: SidecarBridge | undefined

async function createWindow() {
  const settings = await loadSettings()
  bridge = new SidecarBridge(settings)
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: "EasyCode",
    backgroundColor: "#f7f8fb",
    webPreferences: {
      preload: path.join(currentDir, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  bridge.onFrame((frame) => window.webContents.send("sidecar:event", frame))
  if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(process.env.VITE_DEV_SERVER_URL)
  else await window.loadFile(path.join(currentDir, "../renderer/index.html"))
}

ipcMain.handle("settings:get", () => loadSettings())
ipcMain.handle("settings:update", async (_event, patch: Partial<DesktopSettings>) => {
  const current = await loadSettings()
  const next = await saveSettings({ ...current, ...patch })
  bridge?.configure(next)
  return next
})

ipcMain.handle("sidecar:initialize", async () => {
  const settings = await loadSettings()
  bridge?.configure(settings)
  return bridge?.request("initialize", { protocolVersion: 1, root: settings.workspaceRoot, provider: settings.provider, session: settings.session })
})
ipcMain.handle("sidecar:listSessions", () => bridge?.request("listSessions"))
ipcMain.handle("sidecar:runPrompt", (_event, text: string) => bridge?.request("runPrompt", { text }))
ipcMain.handle("sidecar:cancelRun", () => bridge?.request("cancelRun"))
ipcMain.handle("sidecar:replyPermission", (_event, requestId: string, reply: string) => bridge?.request("replyPermission", { requestId, reply }))
ipcMain.handle("sidecar:replyPlan", (_event, runId: string, action: string, text?: string) => bridge?.request("replyPlan", { runId, action, text }))

app.whenReady().then(createWindow)
app.on("window-all-closed", () => {
  bridge?.stop()
  if (process.platform !== "darwin") app.quit()
})
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})
