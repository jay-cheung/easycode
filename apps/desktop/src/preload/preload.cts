const { contextBridge, ipcRenderer } = require("electron")
const { createDesktopApi } = require("./api.cjs") as typeof import("./api.cjs")

contextBridge.exposeInMainWorld("easycode", createDesktopApi(ipcRenderer))
