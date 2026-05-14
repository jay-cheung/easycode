import type { CacheStrategy } from "./cache-policy"

export type ReasoningEffort = "low" | "medium" | "high" | "max"

export type SessionSettings = {
  provider: string
  model?: string
  thinking: boolean
  effort: ReasoningEffort
  selectedSkills: string[]
  cacheStrategy: CacheStrategy
}

export const reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "max"]

export function defaultSessionSettings(provider = "fake"): SessionSettings {
  return { provider, thinking: true, effort: "high", selectedSkills: [], cacheStrategy: "auto" }
}

export function normalizeSessionSettings(input: Partial<SessionSettings> | undefined, fallbackProvider = "fake"): SessionSettings {
  const fallback = defaultSessionSettings(fallbackProvider)
  const effort = input?.effort && isReasoningEffort(input.effort) ? input.effort : fallback.effort
  return {
    provider: typeof input?.provider === "string" && input.provider ? input.provider : fallback.provider,
    model: typeof input?.model === "string" && input.model ? input.model : undefined,
    thinking: typeof input?.thinking === "boolean" ? input.thinking : fallback.thinking,
    effort,
    cacheStrategy: input?.cacheStrategy && isCacheStrategy(input.cacheStrategy) ? input.cacheStrategy : fallback.cacheStrategy,
    selectedSkills: Array.isArray(input?.selectedSkills) ? [...new Set(input.selectedSkills.filter((name): name is string => typeof name === "string" && name.length > 0))] : [],
  }
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (reasoningEfforts as string[]).includes(value)
}

export function isCacheStrategy(value: string): value is CacheStrategy {
  return value === "balanced" || value === "cache-heavy" || value === "auto"
}
