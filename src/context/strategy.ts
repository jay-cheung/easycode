import { clampInt, clampNumber } from "../utils/math"
import type { ContextOptions, ContextStrategyState } from "./types"

export const defaultMaxTokens = 64_000
export const defaultMaxSteps = 66
export const minMaxTokens = 16_000
export const defaultSafetyMultiplier = 1.6
export const minSafetyMultiplier = 1
export const maxSafetyMultiplier = 4
export const defaultActiveWindowUserTurns = 3

export function minTokenFloorForOptions(options: ContextOptions) {
  return options.maxTokens !== undefined && options.maxTokens < minMaxTokens
    ? Math.max(1, Math.round(options.maxTokens))
    : minMaxTokens
}

export function initialMaxTokens(options: ContextOptions, minTokenFloor: number) {
  return clampInt(options.maxTokens ?? defaultMaxTokens, minTokenFloor, options.contextWindowTokens ?? Number.MAX_SAFE_INTEGER)
}

export function responseReserveTokensForMax(maxTokens: number, explicit?: number) {
  return explicit ?? Math.max(2_000, Math.min(8_000, Math.floor(maxTokens * 0.2)))
}

export function defaultCompactPreserveTokens(maxTokens: number) {
  return Math.max(4_000, Math.min(16_000, Math.floor(maxTokens * 0.25)))
}

export function safetyMultiplierForOptions(options: ContextOptions) {
  return clampNumber(options.tokenEstimateSafetyMultiplier ?? defaultSafetyMultiplier, minSafetyMultiplier, maxSafetyMultiplier)
}

export function createInitialStrategyState(options: ContextOptions, maxTokens: number): ContextStrategyState {
  return {
    maxTokens,
    compactAt: clampNumber(options.compactAt ?? 0.75, 0.6, 0.9),
    activeWindowUserTurns: clampInt(options.activeWindowUserTurns ?? options.preserveRecentUserTurns ?? defaultActiveWindowUserTurns, 1, 10),
    toolResultTokenBudget: clampInt(options.toolResultTokenBudget ?? 1_200, 300, 4_000),
    dynamicSummaryTokenBudget: clampInt(options.dynamicSummaryTokenBudget ?? 3_000, 800, 8_000),
    maxSteps: options.maxSteps ?? defaultMaxSteps,
  }
}

export function clampStrategyState(input: ContextStrategyState, minTokenFloor: number, contextWindowTokens: number): ContextStrategyState {
  const maxTokens = clampInt(input.maxTokens, minTokenFloor, contextWindowTokens)
  return {
    maxTokens,
    compactAt: clampNumber(input.compactAt, 0.6, 0.9),
    activeWindowUserTurns: clampInt(input.activeWindowUserTurns, 1, 10),
    toolResultTokenBudget: clampInt(input.toolResultTokenBudget, 300, 4_000),
    dynamicSummaryTokenBudget: clampInt(input.dynamicSummaryTokenBudget, 800, 8_000),
    maxSteps: input.maxSteps,
  }
}
