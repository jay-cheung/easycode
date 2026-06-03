import path from "node:path"
import os from "node:os"
import { createInterface } from "node:readline"
import type { Interface } from "node:readline"
import { stdin as input, stdout as output } from "node:process"
import { hasProvider, listProviders } from "../provider"
import { hasConfiguredWebSearch } from "../retrieval"

export type EnvTarget = {
  [key: string]: string | undefined
}

export const easycodeGlobalEnvHint = "~/.easycode/.env"

type StartupModelConfig = {
  provider: string
  envKey: string
  promptLabel: string
  defaultModel: string
  fallbackChoices: string[]
  modelsURL: string
  apiKeyEnv: string
}

type ModelsListResponse = {
  data?: Array<{ id?: string }>
}

type ModelListFetcher = (input: string, init?: RequestInit) => Promise<Response>

const startupModelConfigs: Record<string, StartupModelConfig> = {
  deepseek: {
    provider: "deepseek",
    envKey: "DEEPSEEK_MODEL",
    promptLabel: "DeepSeek",
    defaultModel: "deepseek-v4-pro",
    fallbackChoices: ["deepseek-v4-pro", "deepseek-v4-flash"],
    modelsURL: "https://api.deepseek.com/models",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  openai: {
    provider: "openai",
    envKey: "OPENAI_MODEL",
    promptLabel: "OpenAI",
    defaultModel: "gpt-5.5",
    fallbackChoices: ["gpt-5.5", "gpt-5.4"],
    modelsURL: "https://api.openai.com/v1/models",
    apiKeyEnv: "OPENAI_API_KEY",
  },
}

export function parseEnvFile(text: string) {
  const entries = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line
    const separator = assignment.indexOf("=")
    if (separator <= 0) continue
    const key = assignment.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    entries.set(key, unquoteEnvValue(assignment.slice(separator + 1)))
  }
  return entries
}

export async function loadEnvFile(root: string, env: EnvTarget = process.env) {
  const localPath = path.join(root, ".env")
  let loaded = 0

  if (process.env.NODE_ENV !== "test") {
    const globalPath = globalEasycodeEnvPath()
    const globalFile = Bun.file(globalPath)
    if (await globalFile.exists()) {
      for (const [key, value] of parseEnvFile(await globalFile.text())) {
        if (env[key] !== undefined) continue
        env[key] = value
        loaded += 1
      }
    }
  }

  const localFile = Bun.file(localPath)
  if (await localFile.exists()) {
    for (const [key, value] of parseEnvFile(await localFile.text())) {
      if (env[key] !== undefined) continue
      env[key] = value
      loaded += 1
    }
  }

  return loaded
}

export function interactiveStartupEnabled(env: EnvTarget = process.env) {
  return input.isTTY || env.EASYCODE_TEST_FORCE_TTY === "1"
}

export function requiredEnvForProvider(provider: string) {
  if (provider === "deepseek") return ["DEEPSEEK_API_KEY"]
  if (provider === "openai") return ["OPENAI_API_KEY"]
  if (provider === "openai-compatible") return ["OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_API_URL"]
  return []
}

export function missingProviderEnv(provider: string, env: EnvTarget = process.env) {
  return requiredEnvForProvider(provider).filter((key) => !env[key])
}

export function needsEnvSetup(provider: string | undefined, env: EnvTarget = process.env) {
  if (!provider) return true
  if (provider === "fake") return false
  return missingProviderEnv(provider, env).length > 0
}

export function startupProviders() {
  return listProviders().filter((provider) => provider !== "fake" && provider !== "simulated")
}

export function startupModelConfig(provider: string) {
  return startupModelConfigs[provider]
}

export function startupModelChoices(provider: string) {
  return startupModelConfig(provider)?.fallbackChoices ?? []
}

export function configuredStartupModel(provider: string, env: EnvTarget = process.env) {
  const config = startupModelConfig(provider)
  if (!config) return undefined
  const value = env[config.envKey]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function selectStartupModel(provider: string, raw: string) {
  const value = raw.trim()
  const config = startupModelConfig(provider)
  if (!config) return undefined
  const choices = startupModelChoices(provider)
  if (!value) return config.defaultModel
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1]
  }
  const preset = choices.find((choice) => choice.toLowerCase() === value.toLowerCase())
  return preset ?? value
}

export function recentStartupModels(provider: string, ids: string[]) {
  if (provider === "openai") return recentOpenAIModels(ids)
  if (provider === "deepseek") return recentDeepSeekModels(ids)
  return []
}

export async function fetchStartupModelChoices(
  provider: string,
  env: EnvTarget = process.env,
  fetcher: ModelListFetcher = globalThis.fetch,
): Promise<string[]> {
  const config = startupModelConfig(provider)
  const apiKey = config ? env[config.apiKeyEnv] : undefined
  if (!config || !apiKey) return startupModelChoices(provider)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetcher(config.modelsURL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) return startupModelChoices(provider)
    const payload = await response.json() as ModelsListResponse
    const ids = payload.data?.flatMap((item) => (typeof item.id === "string" ? [item.id] : [])) ?? []
    const recent = recentStartupModels(provider, ids)
    return recent.length > 0 ? recent : startupModelChoices(provider)
  } catch {
    return startupModelChoices(provider)
  } finally {
    clearTimeout(timer)
  }
}

export function mergeEnvText(existing: string, entries: Record<string, string>) {
  const lines = existing ? existing.replace(/\s*$/, "\n").split(/\n/) : []
  const present = new Set(parseEnvFile(existing).keys())
  for (const [key, value] of Object.entries(entries)) {
    if (present.has(key) || !value) continue
    lines.push(`${key}=${quoteEnvValue(value)}`)
  }
  return lines.join("\n").replace(/\n*$/, "\n")
}

export async function setupInteractiveEnv(root: string, env: EnvTarget = process.env, preselectedProvider?: string): Promise<string | undefined> {
  const initialProvider = preselectedProvider ?? (env.EASYCODE_PROVIDER && hasProvider(env.EASYCODE_PROVIDER) ? env.EASYCODE_PROVIDER : undefined)
  if (!needsEnvSetup(initialProvider, env)) return initialProvider

  const rl = createInterface({ input, output })
  try {
    output.write("\nProvider environment is not configured for this project.\n")
    output.write("easycode can write the missing values to .env. Existing shell variables and .env entries are preserved.\n\n")

    const answer = await new Promise<string>((resolve) => {
      rl.question("Would you like to set up environment variables now? (Y/n): ", resolve)
    })
    if (answer.trim().toLowerCase() === "n") return initialProvider

    const selectedProvider = initialProvider ?? await promptForStartupProvider(rl)
    if (!hasProvider(selectedProvider)) return initialProvider

    const entries: Record<string, string> = { EASYCODE_PROVIDER: selectedProvider }
    await collectProviderEnvEntries(selectedProvider, rl, env, entries)

    const envPath = await writeGlobalEnvEntries(entries)
    applyEnvEntries(env, entries)
    output.write(`\nConfiguration saved to ${envPath}\n`)
    await loadEnvFile(root, env)
    return selectedProvider
  } finally {
    rl.close()
  }
}

export async function setupInteractiveWebSearchEnv(root: string, env: EnvTarget = process.env) {
  if (await hasConfiguredWebSearch(root, env)) return

  const rl = createInterface({ input, output })
  try {
    output.write("\nLive web search is not configured.\n")
    output.write(`easycode can save TAVILY_API_KEY to ${easycodeGlobalEnvHint} for all projects.\n\n`)

    const answer = await new Promise<string>((resolve) => {
      rl.question(`Would you like to configure TAVILY_API_KEY in ${easycodeGlobalEnvHint} now? (Y/n): `, resolve)
    })
    if (answer.trim().toLowerCase() === "n") return

    const apiKey = await new Promise<string>((resolve) => {
      rl.question("Tavily API key (tvly-, leave empty to skip): ", resolve)
    })
    if (!apiKey.trim()) return

    const entries = { TAVILY_API_KEY: apiKey.trim() }
    const envPath = await writeGlobalEnvEntries(entries)
    applyEnvEntries(env, entries)
    output.write(`\nConfiguration saved to ${envPath}\n`)
    await loadEnvFile(root, env)
  } finally {
    rl.close()
  }
}

async function promptForStartupProvider(rl: Interface) {
  const realProviders = startupProviders()
  output.write("\nAvailable providers:\n")
  for (const provider of realProviders) {
    output.write(`  ${provider}\n`)
  }
  output.write("\n")
  const raw = await new Promise<string>((resolve) => {
    rl.question(`Select provider [${realProviders.join("/")}]: `, resolve)
  })
  const provider = raw.trim().toLowerCase() || "deepseek"
  if (!hasProvider(provider)) {
    output.write(`Unknown provider: ${provider}. Skipping setup.\n`)
    return ""
  }
  return provider
}

async function collectProviderEnvEntries(provider: string, rl: Interface, env: EnvTarget, entries: Record<string, string>) {
  if (provider === "deepseek") {
    if (!env.DEEPSEEK_API_KEY) {
      const apiKey = await ask(rl, "DeepSeek API key (sk): ")
      if (apiKey.trim()) entries.DEEPSEEK_API_KEY = apiKey.trim()
    }
    if (!configuredStartupModel(provider, env)) {
      const model = await promptForStartupModel(provider, rl, { ...env, ...entries })
      if (model) entries.DEEPSEEK_MODEL = model
    }
    return
  }

  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) {
      const apiKey = await ask(rl, "OpenAI API key (sk-): ")
      if (apiKey.trim()) entries.OPENAI_API_KEY = apiKey.trim()
    }
    if (!configuredStartupModel(provider, env)) {
      const model = await promptForStartupModel(provider, rl, { ...env, ...entries })
      if (model) entries.OPENAI_MODEL = model
    }
    return
  }

  if (provider === "openai-compatible") {
    if (!env.OPENAI_COMPAT_API_KEY) {
      const apiKey = await ask(rl, "OpenAI-compatible API key: ")
      if (apiKey.trim()) entries.OPENAI_COMPAT_API_KEY = apiKey.trim()
    }
    if (!env.OPENAI_COMPAT_API_URL) {
      const url = await ask(rl, "OpenAI-compatible chat completions URL: ")
      if (url.trim()) entries.OPENAI_COMPAT_API_URL = url.trim()
    }
    if (!env.OPENAI_COMPAT_MODEL) {
      const model = await ask(rl, "OpenAI-compatible model: ")
      if (model.trim()) entries.OPENAI_COMPAT_MODEL = model.trim()
    }
  }
}

async function ask(rl: Interface, prompt: string) {
  return new Promise<string>((resolve) => {
    rl.question(prompt, resolve)
  })
}

async function promptForStartupModel(provider: string, rl: Interface, env: EnvTarget = process.env) {
  const config = startupModelConfig(provider)
  if (!config) return undefined
  const choices = await fetchStartupModelChoices(provider, env)
  output.write(`\n${config.promptLabel} model presets:\n`)
  for (const [index, choice] of choices.entries()) {
    output.write(`  ${index + 1}) ${choice}${choice === config.defaultModel ? " (default)" : ""}\n`)
  }
  output.write("\n")
  const raw = await ask(rl, `Select ${config.promptLabel} model [1-${choices.length} or custom, default: ${config.defaultModel}]: `)
  return selectStartupModelFromChoices(provider, raw, choices)
}

function selectStartupModelFromChoices(provider: string, raw: string, choices: string[]) {
  const config = startupModelConfig(provider)
  if (!config) return undefined
  const value = raw.trim()
  if (!value) return config.defaultModel
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) return choices[numeric - 1]
  const preset = choices.find((choice) => choice.toLowerCase() === value.toLowerCase())
  return preset ?? value
}

function recentOpenAIModels(ids: string[]) {
  const unique = [...new Set(ids)]
  return unique
    .filter((id) => /^gpt-\d+(?:\.\d+)?$/.test(id))
    .sort(compareOpenAIVersionDesc)
    .slice(0, 2)
}

function compareOpenAIVersionDesc(left: string, right: string) {
  const a = left.slice(4).split(".").map((part) => Number(part))
  const b = right.slice(4).split(".").map((part) => Number(part))
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0)
    if (diff !== 0) return diff
  }
  return left.localeCompare(right)
}

function recentDeepSeekModels(ids: string[]) {
  const unique = [...new Set(ids)]
  return unique
    .filter((id) => /^deepseek-v\d+-(?:pro|flash)$/.test(id))
    .sort(compareDeepSeekVersionDesc)
    .slice(0, 2)
}

function compareDeepSeekVersionDesc(left: string, right: string) {
  const leftMatch = left.match(/^deepseek-v(\d+)-(pro|flash)$/)
  const rightMatch = right.match(/^deepseek-v(\d+)-(pro|flash)$/)
  if (!leftMatch || !rightMatch) return left.localeCompare(right)
  const versionDiff = Number(rightMatch[1]) - Number(leftMatch[1])
  if (versionDiff !== 0) return versionDiff
  const rank = (variant: string) => (variant === "pro" ? 0 : 1)
  return rank(leftMatch[2]) - rank(rightMatch[2])
}

function unquoteEnvValue(value: string) {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote !== "\"" && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed
  const inner = trimmed.slice(1, -1)
  if (quote === "'") return inner
  return inner.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t").replaceAll("\\\"", "\"").replaceAll("\\\\", "\\")
}

function quoteEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function globalEasycodeEnvPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".easycode", ".env")
}

async function writeGlobalEnvEntries(entries: Record<string, string>) {
  const envPath = globalEasycodeEnvPath()
  const existing = await Bun.file(envPath).text().catch(() => "# easycode configuration\n")
  await Bun.write(envPath, mergeEnvText(existing, entries))
  return envPath
}

function applyEnvEntries(env: EnvTarget, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    env[key] = value
  }
}
