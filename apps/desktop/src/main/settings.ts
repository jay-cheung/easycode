import { app } from "electron"
import { homedir } from "node:os"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import type { DesktopProviderSetup, DesktopSettings } from "../shared/protocol.js"
import { applyDesktopRuntimeEnv, envEntriesFromText, mergeProviderEnvText, providerDefaultsFromEnvText, providerEnvEntries } from "./provider-env.js"
import { normalizeSettings, normalizeSettingsForStorage } from "./settings-normalize.js"

const settingsFile = () => path.join(app.getPath("userData"), "settings.json")
const globalEnvFile = () => path.join(homedir(), ".easycode", ".env")
type EnvTarget = Record<string, string | undefined>

export async function loadSettings(): Promise<DesktopSettings> {
  await loadGlobalProviderEnvironment()
  const envDefaults = await loadGlobalEnvDefaults()
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), "utf8")) as Partial<DesktopSettings>
    return normalizeSettings(parsed, envDefaults)
  } catch {
    return normalizeSettings({}, envDefaults)
  }
}

export async function saveSettings(input: Partial<DesktopSettings>) {
  await loadGlobalProviderEnvironment()
  const envDefaults = await loadGlobalEnvDefaults()
  const { settings: next, stored } = normalizeSettingsForStorage(input, envDefaults)
  await mkdir(path.dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(stored, null, 2))
  return next
}

export async function configureProviderEnvironment(input: DesktopProviderSetup) {
  const provider = isDesktopProvider(input.provider) ? input.provider : defaultProvider()
  const entries = providerEnvEntries({ ...input, provider })
  const envPath = globalEnvFile()
  const existing = await readFile(envPath, "utf8").catch(() => "# easycode configuration\n")
  await mkdir(path.dirname(envPath), { recursive: true })
  await writeFile(envPath, mergeProviderEnvText(existing, entries))
  for (const [key, value] of Object.entries(entries)) process.env[key] = value
  return { envPath, writtenKeys: Object.keys(entries) }
}

export async function configureUiLanguageEnvironment(language: DesktopSettings["language"]) {
  const envPath = globalEnvFile()
  const existing = await readFile(envPath, "utf8").catch(() => "# easycode configuration\n")
  await mkdir(path.dirname(envPath), { recursive: true })
  await writeFile(envPath, mergeProviderEnvText(existing, { EASYCODE_LANG: language }))
  process.env.EASYCODE_LANG = language
  return envPath
}

export async function loadGlobalProviderEnvironment(env: EnvTarget = process.env) {
  const text = await readFile(globalEnvFile(), "utf8").catch(() => "")
  if (!text) return 0
  return applyDesktopRuntimeEnv(envEntriesFromText(text), env)
}

async function loadGlobalEnvDefaults() {
  const text = await readFile(globalEnvFile(), "utf8").catch(() => "")
  return text ? providerDefaultsFromEnvText(text) : {}
}

function defaultProvider() {
  const configured = process.env.EASYCODE_PROVIDER
  if (configured === "deepseek" || configured === "openai" || configured === "openai-compatible") return configured
  return "deepseek"
}

function isDesktopProvider(value: unknown) {
  return value === "deepseek" || value === "openai" || value === "openai-compatible"
}

export { normalizeSettings }
