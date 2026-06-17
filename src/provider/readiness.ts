import { createProvider, hasProvider, type ProviderName } from "./registry"
import type { ProviderCapabilities, ProviderOptions } from "./types"

export type ProviderReadinessStatus = "ready" | "missing_env" | "unknown_provider" | "invalid"

export type ProviderReadiness = {
  provider: string
  status: ProviderReadinessStatus
  registered: boolean
  missingEnv: string[]
  model?: string
  capabilities?: ProviderCapabilities
  reason?: string
}

export type ProviderEnv = Record<string, string | undefined>

export function requiredProviderEnv(provider: string) {
  if (provider === "deepseek") return ["DEEPSEEK_API_KEY"]
  if (provider === "openai") return ["OPENAI_API_KEY"]
  if (provider === "openai-compatible") return ["OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_API_URL"]
  return []
}

export function missingProviderEnv(provider: string, env: ProviderEnv = process.env) {
  return requiredProviderEnv(provider).filter((key) => !env[key])
}

export function diagnoseProviderReadiness(provider: string, env: ProviderEnv = process.env, options: ProviderOptions = {}): ProviderReadiness {
  if (!hasProvider(provider)) {
    return {
      provider,
      status: "unknown_provider",
      registered: false,
      missingEnv: [],
      reason: `Unknown provider: ${provider}`,
    }
  }

  const missingEnv = missingProviderEnv(provider, env)
  try {
    const instance = createProvider(provider as ProviderName, options)
    return {
      provider,
      status: missingEnv.length > 0 ? "missing_env" : "ready",
      registered: true,
      missingEnv,
      model: instance.model,
      capabilities: instance.capabilities,
      ...(missingEnv.length > 0 ? { reason: `missing ${missingEnv.join(", ")}` } : {}),
    }
  } catch (error) {
    return {
      provider,
      status: "invalid",
      registered: true,
      missingEnv,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function providerReadinessCheckStatus(readiness: ProviderReadiness) {
  if (readiness.status === "ready") return "passed" as const
  if (readiness.status === "missing_env") return "skipped" as const
  return "failed" as const
}

export function formatProviderReadinessSummary(readiness: ProviderReadiness) {
  if (readiness.status === "ready") {
    return `${readiness.provider} ready${readiness.model ? ` (${readiness.model})` : ""}`
  }
  return readiness.reason ?? readiness.status
}
