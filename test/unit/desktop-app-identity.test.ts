import { describe, expect, test } from "bun:test"
import { configureDesktopAppIdentity, desktopApplicationName, type DesktopAppIdentityTarget } from "../../apps/desktop/src/main/app-identity"

describe("desktop app identity", () => {
  test("sets Electron-visible app names for dev and packaged runs", () => {
    const calls: unknown[] = []
    const app: DesktopAppIdentityTarget = {
      name: "Electron",
      setName: (name) => calls.push(["setName", name]),
      setAboutPanelOptions: (options) => calls.push(["setAboutPanelOptions", options]),
      setAppUserModelId: (id) => calls.push(["setAppUserModelId", id]),
    }
    const processLike = { title: "Electron" }

    configureDesktopAppIdentity(app, processLike)

    expect(desktopApplicationName).toBe("easycode")
    expect(app.name).toBe("easycode")
    expect(processLike.title).toBe("easycode")
    expect(calls).toEqual([
      ["setName", "easycode"],
      ["setAboutPanelOptions", { applicationName: "easycode" }],
      ["setAppUserModelId", "dev.easycode.desktop"],
    ])
  })
})
