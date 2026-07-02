import type { DesktopApi, DesktopLoadSessionResult, DesktopSettings, DesktopSettingsPatch } from "../shared/protocol.js"

type DesktopSettingsSyncApi = Pick<DesktopApi, "initialize" | "updateSettings" | "updateSidecarSettings">

export function sidecarSettingsPatch(settings: Partial<DesktopSettings>): DesktopSettingsPatch {
  return {
    ...(hasOwn(settings, "provider") ? { provider: settings.provider } : {}),
    ...(hasOwn(settings, "model") ? { model: settings.model ?? null } : {}),
    ...(hasOwn(settings, "language") ? { language: settings.language } : {}),
    ...(hasOwn(settings, "thinking") ? { thinking: settings.thinking } : {}),
    ...(hasOwn(settings, "effort") ? { effort: settings.effort } : {}),
    ...(hasOwn(settings, "maxTokens") ? { maxTokens: settings.maxTokens ?? null } : {}),
    ...(hasOwn(settings, "maxSteps") ? { maxSteps: settings.maxSteps ?? null } : {}),
    ...(hasOwn(settings, "selectedSkills") ? { selectedSkills: settings.selectedSkills } : {}),
    ...(hasOwn(settings, "pendingSkillLoads") ? { pendingSkillLoads: settings.pendingSkillLoads } : {}),
    ...(hasOwn(settings, "session") ? { session: settings.session } : {}),
  }
}

export async function reconcileDesktopSettingsFromSidecar(api: Pick<DesktopSettingsSyncApi, "initialize" | "updateSettings">, settings: Partial<DesktopSettings>) {
  const next = await api.updateSettings(settings)
  await api.initialize()
  return next
}

export async function applyDirectDesktopSettings(api: DesktopSettingsSyncApi, patch: Partial<DesktopSettings>) {
  const next = await api.updateSettings(patch)
  await api.initialize()
  const sidecarResult = await api.updateSidecarSettings(sidecarSettingsPatch(patch), next.workspaceRoot)
  return sidecarResult.settings ? await api.updateSettings(sidecarResult.settings) : next
}

export async function restoreLoadedSessionSettings(api: Pick<DesktopSettingsSyncApi, "initialize" | "updateSettings">, session: string, loadedSettings: DesktopLoadSessionResult["settings"]) {
  const next = await api.updateSettings({ ...loadedSettings, session })
  await api.initialize()
  return next
}

function hasOwn<T extends object>(value: T, key: keyof T) {
  return Object.prototype.hasOwnProperty.call(value, key)
}
