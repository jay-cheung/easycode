export const desktopConfigSettingKeys = [
  "provider",
  "model",
  "language",
  "thinking",
  "effort",
  "maxTokens",
  "maxSteps",
] as const

export type DesktopConfigSettingKey = typeof desktopConfigSettingKeys[number]

export type DesktopConfigSettingValue = {
  provider: string
  model: string
  language: string
  thinking: boolean
  effort: string
  maxTokens: number | undefined
  maxSteps: number | undefined
}

export function desktopConfigCommand<K extends DesktopConfigSettingKey>(key: K, value: DesktopConfigSettingValue[K]) {
  switch (key) {
    case "provider": return providerSettingsCommand(String(value))
    case "model": return modelSettingsCommand(String(value))
    case "language": return languageSettingsCommand(String(value))
    case "thinking": return thinkingSettingsCommand(Boolean(value))
    case "effort": return effortSettingsCommand(String(value))
    case "maxTokens": return maxTokensSettingsCommand(value as DesktopConfigSettingValue["maxTokens"])
    case "maxSteps": return maxStepsSettingsCommand(value as DesktopConfigSettingValue["maxSteps"])
  }
}

export function providerSettingsCommand(provider: string) {
  return `/provider ${provider}`
}

export function modelSettingsCommand(model: string) {
  const trimmed = model.trim()
  return trimmed ? `/model ${trimmed}` : "/model reset"
}

export function thinkingSettingsCommand(enabled: boolean) {
  return `/thinking ${enabled ? "on" : "off"}`
}

export function effortSettingsCommand(effort: string) {
  return `/effort ${effort}`
}

export function languageSettingsCommand(language: string) {
  return `/lang ${language}`
}

export function maxTokensSettingsCommand(value: number | undefined) {
  return `/max-tokens ${value ?? "reset"}`
}

export function maxStepsSettingsCommand(value: number | undefined) {
  return `/max-steps ${value ?? "reset"}`
}
