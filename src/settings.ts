import { detectUiLanguage, normalizeUiLanguage, type UiLanguage } from "./i18n"

export type ReasoningEffort = "low" | "medium" | "high" | "max"

export type SessionSettings = {
  provider: string
  model?: string
  language: UiLanguage
  thinking: boolean
  effort: ReasoningEffort
  selectedSkills: string[]
  pendingSkillLoads: string[]
  maxTokens?: number
  maxSteps?: number
  responseReserveTokens?: number
}

export const reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "max"]
export const defaultProviderName = "openai"
export const maxSessionTokens = 256_000
export const maxSessionSteps = 200
export const maxResponseReserveTokens = 64_000

export function defaultSessionSettings(provider = defaultProviderName): SessionSettings {
  return { provider, language: detectUiLanguage(), thinking: true, effort: "high", selectedSkills: [], pendingSkillLoads: [], maxTokens: 64_000, maxSteps: 66 }
}

export function normalizeSessionSettings(input: Partial<SessionSettings> | undefined, fallbackProvider = defaultProviderName): SessionSettings {
  const fallback = defaultSessionSettings(fallbackProvider)
  const effort = input?.effort && isReasoningEffort(input.effort) ? input.effort : fallback.effort
  const selectedSkills = uniqueStringList(input?.selectedSkills)
  return {
    provider: typeof input?.provider === "string" && input.provider ? input.provider : fallback.provider,
    model: typeof input?.model === "string" && input.model ? input.model : undefined,
    language: normalizeUiLanguage(input?.language, fallback.language),
    thinking: typeof input?.thinking === "boolean" ? input.thinking : fallback.thinking,
    effort,
    maxTokens: boundedPositiveInteger(input?.maxTokens, maxSessionTokens) ?? fallback.maxTokens,
    maxSteps: boundedPositiveInteger(input?.maxSteps, maxSessionSteps) ?? fallback.maxSteps,
    responseReserveTokens: boundedPositiveInteger(input?.responseReserveTokens, maxResponseReserveTokens),
    selectedSkills,
    pendingSkillLoads: Array.isArray(input?.pendingSkillLoads) ? uniqueStringList(input.pendingSkillLoads) : selectedSkills,
  }
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (reasoningEfforts as string[]).includes(value)
}

function boundedPositiveInteger(value: unknown, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(max, Math.round(value))
}

function uniqueStringList(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === "string" && name.length > 0))] : []
}
