import type { DesktopProviderSetup } from "../shared/protocol.js"

export type ProviderEnvDefaults = {
  provider?: string
  model?: string
  language?: string
}

export function providerEnvEntries(input: DesktopProviderSetup & { provider: string }) {
  const entries: Record<string, string> = { EASYCODE_PROVIDER: input.provider }
  const apiKey = input.apiKey?.trim()
  const model = input.model?.trim()
  const baseUrl = input.baseUrl?.trim()
  if (input.provider === "deepseek") {
    setEntry(entries, envName("DEEPSEEK", "API", "KEY"), apiKey)
    if (model) entries.DEEPSEEK_MODEL = model
  } else if (input.provider === "openai") {
    setEntry(entries, envName("OPENAI", "API", "KEY"), apiKey)
    if (model) entries.OPENAI_MODEL = model
  } else if (input.provider === "openai-compatible") {
    setEntry(entries, envName("OPENAI", "COMPAT", "API", "KEY"), apiKey)
    setEntry(entries, "OPENAI_COMPAT_API_URL", baseUrl)
    if (model) entries.OPENAI_COMPAT_MODEL = model
  }
  return entries
}

export function providerDefaultsFromEnvText(text: string): ProviderEnvDefaults {
  const entries = parseEnvText(text)
  const provider = entries.EASYCODE_PROVIDER
  const model = modelFromEnvEntries(entries, provider)
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(entries.EASYCODE_LANG ? { language: entries.EASYCODE_LANG } : {}),
  }
}

export function envEntriesFromText(text: string) {
  return parseEnvText(text)
}

export function mergeProviderEnvText(existing: string, entries: Record<string, string>) {
  const lines = existing.trim() ? existing.replace(/\s*$/, "").split(/\n/) : ["# easycode configuration"]
  const seen = new Set<string>()
  const next = lines.map((rawLine) => {
    const match = rawLine.match(/^(\s*(?:export\s+)?)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    const key = match?.[2]
    if (!key || entries[key] === undefined) return rawLine
    seen.add(key)
    const prefix = match[1] ?? ""
    return `${prefix}${key}=${quoteEnvValue(entries[key])}`
  })
  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key)) next.push(`${key}=${quoteEnvValue(value)}`)
  }
  return next.join("\n").replace(/\n*$/, "\n")
}

function modelFromEnvEntries(entries: Record<string, string>, provider: string | undefined) {
  if (provider === "deepseek") return entries.DEEPSEEK_MODEL
  if (provider === "openai") return entries.OPENAI_MODEL
  if (provider === "openai-compatible") return entries.OPENAI_COMPAT_MODEL
  return undefined
}

function parseEnvText(text: string) {
  const entries: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line
    const separator = assignment.indexOf("=")
    if (separator <= 0) continue
    const key = assignment.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    entries[key] = unquoteEnvValue(assignment.slice(separator + 1).trim())
  }
  return entries
}

function unquoteEnvValue(value: string) {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed === "string" ? parsed : value
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

function quoteEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function setEntry(entries: Record<string, string>, key: string, value: string | undefined) {
  if (value) entries[key] = value
}

function envName(...parts: string[]) {
  return parts.join("_")
}
