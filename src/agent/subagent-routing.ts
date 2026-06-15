import { createProvider, hasProvider, type Provider, type ProviderCapabilities, type ProviderName, type ProviderOptions } from "../provider"
import type { ReasoningEffort, SessionSettings } from "../settings"
import type { SubagentRole } from "./types"

export type SubagentExecutionPreset = {
  thinking: boolean
  effort?: ReasoningEffort
  maxProviderCalls: number
}

export type SubagentRoute = {
  role: SubagentRole
  provider: string
  model?: string
  thinking: boolean
  effort?: ReasoningEffort
  maxProviderCalls: number
  maxOutputTokens?: number
}

const reasoningOrder: ReasoningEffort[] = ["low", "medium", "high", "max"]

const defaultSubagentPresets: Record<SubagentRole, SubagentExecutionPreset> = {
  summary: { thinking: true, effort: "low", maxProviderCalls: 2 },
  explorer: { thinking: false, maxProviderCalls: 6 },
  reviewer: { thinking: true, effort: "medium", maxProviderCalls: 3 },
  debugger: { thinking: true, effort: "high", maxProviderCalls: 5 },
  tester: { thinking: false, maxProviderCalls: 3 },
  docs_researcher: { thinking: false, maxProviderCalls: 5 },
}

const deepSeekSubagentPresets: Partial<Record<SubagentRole, SubagentExecutionPreset>> = {
  summary: { thinking: true, effort: "high", maxProviderCalls: 2 },
  reviewer: { thinking: true, effort: "high", maxProviderCalls: 3 },
  debugger: { thinking: true, effort: "max", maxProviderCalls: 5 },
}

export function resolveSubagentRoute(input: {
  role: SubagentRole
  provider?: string
  model?: string
  capabilities?: ProviderCapabilities
  settings: SessionSettings
  maxOutputTokens?: number
}): SubagentRoute {
  const provider = input.provider ?? input.settings.provider
  const model = subagentModel(provider, input.model ?? input.settings.model)
  const preset = subagentPreset(input.role, provider)
  const route: SubagentRoute = {
    role: input.role,
    provider,
    model,
    thinking: preset.thinking,
    effort: preset.effort,
    maxProviderCalls: preset.maxProviderCalls,
    maxOutputTokens: input.maxOutputTokens,
  }
  return clampSubagentRoute(route, input.capabilities)
}

export function createDerivedSubagentProvider(
  baseProvider: Provider,
  route: SubagentRoute,
  instrument?: (provider: Provider) => Provider,
): Provider {
  if (!hasProvider(route.provider)) return instrument ? instrument(baseProvider) : baseProvider
  const runtime: ProviderOptions = {
    ...(baseProvider.runtime ?? {}),
    model: route.model,
    thinking: route.thinking,
    effort: route.effort,
    maxOutputTokens: route.maxOutputTokens,
  }
  const derived = createProvider(route.provider as ProviderName, runtime)
  return instrument ? instrument(derived) : derived
}

export function clampSubagentRoute(route: SubagentRoute, capabilities: ProviderCapabilities | undefined): SubagentRoute {
  const maxProviderCalls = Math.max(1, Math.round(route.maxProviderCalls || 1))
  if (!capabilities?.supportsThinking) {
    return {
      ...route,
      thinking: false,
      effort: undefined,
      maxProviderCalls,
      maxOutputTokens: clampMaxOutputTokens(route.maxOutputTokens, capabilities),
    }
  }
  if (!route.thinking) {
    return {
      ...route,
      effort: undefined,
      maxProviderCalls,
      maxOutputTokens: clampMaxOutputTokens(route.maxOutputTokens, capabilities),
    }
  }
  if (!capabilities.supportsReasoningEffort) {
    return {
      ...route,
      effort: undefined,
      maxProviderCalls,
      maxOutputTokens: clampMaxOutputTokens(route.maxOutputTokens, capabilities),
    }
  }
  const effort = clampEffort(route.effort, capabilities.effortValues)
  return {
    ...route,
    effort,
    maxProviderCalls,
    maxOutputTokens: clampMaxOutputTokens(route.maxOutputTokens, capabilities),
  }
}

function subagentPreset(role: SubagentRole, provider: string): SubagentExecutionPreset {
  if (provider === "deepseek") return deepSeekSubagentPresets[role] ?? defaultSubagentPresets[role]
  return defaultSubagentPresets[role]
}

function subagentModel(provider: string, model: string | undefined) {
  if (provider === "deepseek") return "deepseek-v4-flash"
  return model
}

function clampEffort(effort: ReasoningEffort | undefined, supported: ReasoningEffort[]): ReasoningEffort | undefined {
  if (!effort || supported.length === 0) return undefined
  if (supported.includes(effort)) return effort
  const requestedIndex = reasoningOrder.indexOf(effort)
  const candidates = supported
    .map((value) => ({ value, index: reasoningOrder.indexOf(value) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
  const lowerOrEqual = [...candidates].reverse().find((entry) => entry.index <= requestedIndex)
  return lowerOrEqual?.value ?? candidates[0]?.value
}

function clampMaxOutputTokens(maxOutputTokens: number | undefined, capabilities: ProviderCapabilities | undefined) {
  if (!capabilities?.supportsMaxOutputTokens) return undefined
  if (typeof maxOutputTokens !== "number" || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return undefined
  return Math.max(1, Math.round(maxOutputTokens))
}
