export const desktopApplicationName = "easycode"

export type DesktopAppIdentityTarget = {
  name?: string
  setName(name: string): void
  setAboutPanelOptions?(options: { applicationName: string }): void
  setAppUserModelId?(id: string): void
}

export function configureDesktopAppIdentity(app: DesktopAppIdentityTarget, processLike: { title?: string } = process) {
  app.name = desktopApplicationName
  app.setName(desktopApplicationName)
  app.setAboutPanelOptions?.({ applicationName: desktopApplicationName })
  app.setAppUserModelId?.("dev.easycode.desktop")
  processLike.title = desktopApplicationName
}
