import type { DesktopProviderReadiness } from "../shared/protocol.js"

export function providerReadinessLabel(readiness: DesktopProviderReadiness | undefined) {
  if (!readiness) return "Unknown"
  if (readiness.status === "ready") return "Ready"
  if (readiness.status === "missing_env") return "Missing config"
  if (readiness.status === "unknown_provider") return "Unknown"
  return "Invalid"
}

export function providerReadinessDetail(readiness: DesktopProviderReadiness | undefined) {
  if (!readiness) return "Not checked yet"
  if (readiness.missingEnv.length > 0) return `Missing ${readiness.missingEnv.join(", ")}`
  return readiness.reason ?? readiness.model
}

export function providerReadinessError(readiness: DesktopProviderReadiness) {
  const detail = providerReadinessDetail(readiness)
  return detail ? `${providerReadinessLabel(readiness)}: ${detail}` : providerReadinessLabel(readiness)
}

export function providerSetupRequirements(provider: string, readiness: DesktopProviderReadiness) {
  const missing = readiness.provider === provider ? new Set(readiness.missingEnv) : undefined
  if (provider === "openai") {
    return { apiKeyEnv: "OPENAI_API_KEY", apiKeyRequired: missing ? missing.has("OPENAI_API_KEY") : true, baseUrlEnv: undefined, baseUrlRequired: false }
  }
  if (provider === "openai-compatible") {
    return {
      apiKeyEnv: "OPENAI_COMPAT_API_KEY",
      apiKeyRequired: missing ? missing.has("OPENAI_COMPAT_API_KEY") : true,
      baseUrlEnv: "OPENAI_COMPAT_API_URL",
      baseUrlRequired: missing ? missing.has("OPENAI_COMPAT_API_URL") : true,
    }
  }
  return { apiKeyEnv: "DEEPSEEK_API_KEY", apiKeyRequired: missing ? missing.has("DEEPSEEK_API_KEY") : true, baseUrlEnv: undefined, baseUrlRequired: false }
}

export function providerSetupStatus(provider: string, readiness: DesktopProviderReadiness, requirements: ReturnType<typeof providerSetupRequirements>) {
  if (readiness.provider === provider) {
    return {
      label: providerReadinessLabel(readiness),
      detail: providerReadinessDetail(readiness) ?? provider,
    }
  }
  const keys = [requirements.apiKeyEnv, requirements.baseUrlEnv].filter(Boolean).join(" and ")
  return {
    label: "Configuration required",
    detail: `Enter ${keys} to switch to ${provider}.`,
  }
}
