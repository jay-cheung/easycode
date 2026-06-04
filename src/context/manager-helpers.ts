import type { CachePricing } from "../cache-policy"
import type { ContextPlanInput, ContextStrategyState } from "./types"
import { hasSkillPrompt } from "../prompt"
import type { ProviderInputMessage } from "../message"
import { estimateTextTokens } from "./tokens"

export type WindowStats = {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export function staticPrefixMessageCount(input: ContextPlanInput) {
  return 1 + ((input.instructions?.length ?? 0) > 0 ? 1 : 0) + (hasSkillPrompt(input.skills, input.selectedSkills ?? []) ? 1 : 0)
}

export function estimateStaticPrefixTokens(messages: ProviderInputMessage[], count: number) {
  return estimateTextTokens(messages.slice(0, count).map((message) => message.content).join("\n"))
}

export function emptyWindowStats(): WindowStats {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
}

export function addWindowStats(target: WindowStats, input: WindowStats) {
  target.calls += input.calls
  target.inputTokens += input.inputTokens
  target.outputTokens += input.outputTokens
  target.cacheHitTokens += input.cacheHitTokens
  target.cacheMissTokens += input.cacheMissTokens
}

export function cloneStrategy(input: ContextStrategyState): ContextStrategyState {
  return { ...input }
}

export function effectiveWindowCost(input: WindowStats, pricing: CachePricing) {
  return input.cacheMissTokens * pricing.inputCacheMiss + input.cacheHitTokens * pricing.inputCacheHit
}

export function truncateToTokenBudget(text: string, tokenBudget: number) {
  if (estimateTextTokens(text) <= tokenBudget) return text
  const charBudget = Math.max(0, Math.floor(tokenBudget / 0.3))
  return `${text.slice(0, charBudget)}\n[truncated summary to ${tokenBudget} estimated tokens]`
}
