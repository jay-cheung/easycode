import type { DesktopReasoningEffort } from "../shared/protocol.js"
import type { SelectOption } from "./app-types.js"

export type EffortOptionsCopy = {
  effortHigh: string
  effortLow: string
  effortMax: string
  effortMedium: string
}

export type LanguageOptionsCopy = {
  languageName: (code: string) => string
}

export function normalizeSelectOptions(options: Array<string | SelectOption>, value: string) {
  const normalized = options.map((option) => typeof option === "string" ? { value: option, label: option } : option).filter((option) => option.value)
  if (value && !normalized.some((option) => option.value === value)) return [{ value, label: value }, ...normalized]
  return normalized
}

export function languageSelectOptions(copy: LanguageOptionsCopy): SelectOption[] {
  const languages = ["en", "zh", "ja", "fr", "ko", "de"]
  return languages.map((value) => ({ value, label: copy.languageName(value) }))
}

export function effortSelectOptions(copy: EffortOptionsCopy): SelectOption[] {
  return [
    { value: "low", label: copy.effortLow },
    { value: "medium", label: copy.effortMedium },
    { value: "high", label: copy.effortHigh },
    { value: "max", label: copy.effortMax },
  ] satisfies Array<SelectOption & { value: DesktopReasoningEffort }>
}

export function modelSelectOptions(provider: string, selected?: string): SelectOption[] {
  return normalizeSelectOptions(providerModelOptions(provider), selected ?? defaultSetupModel(provider))
}

export function providerModelOptions(provider: string) {
  if (provider === "openai") return ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]
  if (provider === "openai-compatible") return ["openai-compatible"]
  return ["deepseek-v4-pro", "deepseek-v4-flash"]
}

export function defaultSetupModel(provider: string) {
  return providerModelOptions(provider)[0] ?? "deepseek-v4-pro"
}
