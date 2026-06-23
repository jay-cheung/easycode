import type { DesktopSettings } from "../shared/protocol.js"
import type { ProviderEnvDefaults } from "./provider-env.js"

const desktopSessionLimit = {
  contextBudget: 256_000,
  steps: 200,
}

export function normalizeSettings(input: Partial<DesktopSettings>, envDefaults: ProviderEnvDefaults = {}): DesktopSettings {
  const workspaceRoot = input.workspaceRoot || process.cwd()
  const sidecarPath = typeof input.sidecarPath === "string" ? input.sidecarPath.trim() : undefined
  const provider = isDesktopProvider(input.provider) ? input.provider : isDesktopProvider(envDefaults.provider) ? envDefaults.provider : defaultProvider()
  const envModel = envDefaults.provider === provider ? envDefaults.model : undefined
  const inputModel = typeof input.model === "string" ? input.model.trim() : undefined
  const explicitModelReset = hasOwn(input, "model") && !inputModel
  return {
    workspaceRoot,
    sidecarPath: sidecarPath || undefined,
    provider,
    model: explicitModelReset ? undefined : inputModel || envModel || undefined,
    language: isLanguage(input.language) ? input.language : isLanguage(envDefaults.language) ? envDefaults.language : "en",
    thinking: typeof input.thinking === "boolean" ? input.thinking : true,
    effort: isEffort(input.effort) ? input.effort : "high",
    maxTokens: boundedPositiveInteger(input.maxTokens, desktopSessionLimit.contextBudget),
    maxSteps: boundedPositiveInteger(input.maxSteps, desktopSessionLimit.steps),
    selectedSkills: stringList(input.selectedSkills),
    pendingSkillLoads: stringList(input.pendingSkillLoads),
    session: input.session || "default",
    recentWorkspaces: unique([...(input.recentWorkspaces ?? []), workspaceRoot]).slice(0, 8),
  }
}

export function normalizeSettingsForStorage(input: Partial<DesktopSettings>, envDefaults: ProviderEnvDefaults = {}) {
  const settings = normalizeSettings(input, envDefaults)
  const stored: Partial<DesktopSettings> & { model?: string } = { ...settings }
  if (hasOwn(input, "model") && !settings.model) stored.model = ""
  return { settings, stored }
}

function defaultProvider() {
  const configured = process.env.EASYCODE_PROVIDER
  if (configured === "deepseek" || configured === "openai" || configured === "openai-compatible") return configured
  return "deepseek"
}

function isDesktopProvider(value: unknown) {
  return value === "deepseek" || value === "openai" || value === "openai-compatible"
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function isEffort(value: unknown): value is DesktopSettings["effort"] {
  return value === "low" || value === "medium" || value === "high" || value === "max"
}

function isLanguage(value: unknown): value is DesktopSettings["language"] {
  return value === "en" || value === "zh" || value === "ja" || value === "fr" || value === "ko" || value === "de"
}

function hasOwn<T extends object>(value: T, key: keyof T) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function boundedPositiveInteger(value: unknown, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(max, Math.round(value))
}

function stringList(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : []
}
