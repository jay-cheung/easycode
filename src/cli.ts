#!/usr/bin/env bun
import path from "node:path"
import os from "node:os"
import { createInterface } from "node:readline"
import { stdin as input, stdout as output } from "node:process"
import { createRunner, hasProposedPlanText } from "./agent"
import type { ContextManagerLike } from "./context"
import { imageLabel, imagePartFromInput } from "./image"
import { createLogger, emitLog } from "./logger"
import type { AgentMode, ImagePart } from "./message"
import { defaultPermissionAutoReviewer, defaultPermissionRules, PermissionService, type PermissionRequest } from "./permission"
import { createProvider, defaultProviderCapabilities, hasProvider, listProviders } from "./provider"
import { savePlan } from "./plans"
import { SessionStore } from "./session"
import { isReasoningEffort, normalizeSessionSettings, type SessionSettings } from "./settings"
import { parseSlashCommand, slashHelpText, type SlashCommand } from "./slash"
import { SkillService } from "./skill"
import { TimelineRenderer, type RunUiEvent } from "./ui/timeline"
import { TuiRenderer } from "./ui/tui"

type EnvTarget = {
  [key: string]: string | undefined
}

const eofPrompt = "\0__easycode_eof__"

type LinePriority = "foreground" | "background"

type LineWaiter = {
  resolve: (line: string) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type RunRenderer = {
  event(event: RunUiEvent): void
  finish(): void
}

class LineReader {
  private pending: string[] = []
  private readonly foreground: LineWaiter[] = []
  private readonly background: LineWaiter[] = []

  constructor(private readonly rl: ReturnType<typeof createInterface>) {
    this.rl.on("line", (line) => this.receive(line))
    this.rl.on("close", () => this.closeWaiters())
  }

  question(prompt: string, priority: LinePriority = "foreground", signal?: AbortSignal) {
    output.write(prompt)
    return this.nextLine(priority, signal)
  }

  nextLine(priority: LinePriority = "foreground", signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve(eofPrompt)
    const queued = priority === "foreground" ? this.pending.shift() : undefined
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<string>((resolve) => {
      const waiter: LineWaiter = { resolve, signal }
      waiter.onAbort = () => {
        this.removeWaiter(waiter)
        resolve(eofPrompt)
      }
      signal?.addEventListener("abort", waiter.onAbort, { once: true })
      ;(priority === "foreground" ? this.foreground : this.background).push(waiter)
    })
  }

  close() {
    this.rl.close()
  }

  private receive(line: string) {
    const waiter = this.foreground.shift() ?? this.background.shift()
    if (!waiter) {
      this.pending.push(line)
      return
    }
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort)
    waiter.resolve(line)
  }

  private removeWaiter(waiter: LineWaiter) {
    removeItem(this.foreground, waiter)
    removeItem(this.background, waiter)
  }

  private closeWaiters() {
    for (const waiter of [...this.foreground.splice(0), ...this.background.splice(0)]) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort)
      waiter.resolve(eofPrompt)
    }
  }
}

function removeItem<T>(items: T[], item: T) {
  const index = items.indexOf(item)
  if (index !== -1) items.splice(index, 1)
}

export function parseArgs(argv: string[]) {
  const normalizedArgv = normalizeModeArgv(argv)
  const mode = normalizedArgv[0]
  if (mode !== "build" && mode !== "plan") throw new Error(usage())
  const providerIndex = normalizedArgv.indexOf("--provider")
  const rootIndex = normalizedArgv.indexOf("--root")
  const sessionIndex = normalizedArgv.indexOf("--session")
  const modelIndex = normalizedArgv.indexOf("--model")
  const maxTokensIndex = normalizedArgv.indexOf("--max-tokens")
  const maxStepsIndex = normalizedArgv.indexOf("--max-steps")
  const once = normalizedArgv.includes("--once")
  const logger = normalizedArgv.includes("--logger")
  if (logger) {
    process.env.EASYCODE_LOGGER = "true"
  }
  const tui = normalizedArgv.includes("--tui")
  const providerExplicit = providerIndex !== -1
  const rawProvider = providerIndex === -1 ? "fake" : normalizedArgv[providerIndex + 1]
  if (!hasProvider(rawProvider)) throw new Error(`Unknown provider: ${rawProvider}. Available providers: ${listProviders().join(", ")}`)
  const provider = rawProvider
  const root = rootIndex === -1 ? process.cwd() : path.resolve(normalizedArgv[rootIndex + 1])
  const explicitSession = sessionIndex === -1 ? undefined : normalizedArgv[sessionIndex + 1]
  if (sessionIndex !== -1 && (!explicitSession || explicitSession.startsWith("--"))) throw new Error("--session requires an id")
  const model = modelIndex === -1 ? undefined : normalizedArgv[modelIndex + 1]
  if (modelIndex !== -1 && (!model || model.startsWith("--"))) throw new Error("--model requires an id")
  const maxTokens = numericFlag(normalizedArgv, maxTokensIndex, "--max-tokens")
  const maxSteps = numericFlag(normalizedArgv, maxStepsIndex, "--max-steps")
  const prompt = normalizedArgv.slice(1).filter((arg, index, items) => {
    const realIndex = index + 1
    return !arg.startsWith("--") && realIndex !== providerIndex + 1 && realIndex !== rootIndex + 1 && realIndex !== sessionIndex + 1 && realIndex !== modelIndex + 1 && realIndex !== maxTokensIndex + 1 && realIndex !== maxStepsIndex + 1 && items[realIndex - 1] !== "--provider" && items[realIndex - 1] !== "--root" && items[realIndex - 1] !== "--session" && items[realIndex - 1] !== "--model" && items[realIndex - 1] !== "--max-tokens" && items[realIndex - 1] !== "--max-steps"
  }).join(" ")
  if (!once && prompt) throw new Error("Session mode is interactive; use --once for startup prompts")
  return { mode: mode as AgentMode, prompt, provider, providerExplicit, model, maxTokens, maxSteps, root, logger, session: explicitSession, once, tui }
}

function normalizeModeArgv(argv: string[]) {
  const mode = argv[0]
  if (mode === "build" || mode === "plan") return argv
  return ["build", ...argv]
}

function usage() {
  return `Usage: easycode [build|plan] [--once prompt] [--provider ${listProviders().join("|")}] [--model id] [--max-tokens n] [--max-steps n] [--root path] [--logger] [--tui] [--session id]`
}

function numericFlag(argv: string[], index: number, name: string) {
  if (index === -1) return undefined
  const raw = argv[index + 1]
  const value = Number(raw)
  if (!raw || raw.startsWith("--") || !Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`)
  return Math.round(value)
}

function unquoteEnvValue(value: string) {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed
  const inner = trimmed.slice(1, -1)
  if (quote === "'") return inner
  return inner.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t").replaceAll('\\"', '"').replaceAll("\\\\", "\\")
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
  const globalPath = path.join(os.homedir(), ".easycode", ".env")
  const localPath = path.join(root, ".env")
  let loaded = 0

  // 1. Load global .env
  const globalFile = Bun.file(globalPath)
  if (await globalFile.exists()) {
    for (const [key, value] of parseEnvFile(await globalFile.text())) {
      if (env[key] !== undefined) continue
      env[key] = value
      loaded += 1
    }
  }

  // 2. Load local .env (backward compatibility)
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

async function main() {
  let args = parseArgs(process.argv.slice(2))
  const loadedEnvVars = await loadEnvFile(args.root)
  // Use EASYCODE_PROVIDER from .env if --provider was not explicit
  if (!args.providerExplicit && process.env.EASYCODE_PROVIDER && hasProvider(process.env.EASYCODE_PROVIDER)) {
    args = { ...args, provider: process.env.EASYCODE_PROVIDER }
  }
  if (input.isTTY) {
    const preselectedProvider = args.providerExplicit && hasProvider(args.provider) ? args.provider : args.provider === "fake" ? undefined : args.provider
    const selectedProvider = await setupInteractiveEnv(args.root, process.env, preselectedProvider)
    if (!args.providerExplicit && selectedProvider && hasProvider(selectedProvider)) {
      args = { ...args, provider: selectedProvider }
    }
  }
  const status = args.once ? await runOnce(args, loadedEnvVars) : await runSession(args, loadedEnvVars)
  return status === "completed" ? 0 : 1
}

if (import.meta.main) {
  const exitCode = await main().catch((error: unknown) => {
    console.error(formatCliError(error))
    return 1
  })
  process.exit(exitCode)
}

function formatCliError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  if (!trimmed) return "easycode failed. Please try again."
  if (trimmed.startsWith("Usage:")) return trimmed
  return `easycode failed: ${trimmed}`
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

export function mergeEnvText(existing: string, entries: Record<string, string>) {
  const lines = existing ? existing.replace(/\s*$/, "\n").split(/\n/) : []
  const present = new Set(parseEnvFile(existing).keys())
  for (const [key, value] of Object.entries(entries)) {
    if (present.has(key) || !value) continue
    lines.push(`${key}=${quoteEnvValue(value)}`)
  }
  return lines.join("\n").replace(/\n*$/, "\n")
}

function quoteEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return JSON.stringify(value)
}

async function setupInteractiveEnv(root: string, env: EnvTarget = process.env, preselectedProvider?: string): Promise<string | undefined> {
  const initialProvider = preselectedProvider ?? (env.EASYCODE_PROVIDER && hasProvider(env.EASYCODE_PROVIDER) ? env.EASYCODE_PROVIDER : undefined)
  if (!needsEnvSetup(initialProvider, env)) return initialProvider

  const rl = createInterface({ input, output })
  try {
    output.write("\n⚠️  Provider environment is not configured for this project.\n")
    output.write("   easycode can write the missing values to .env. Existing shell variables and .env entries are preserved.\n\n")

    const answer = await new Promise<string>((resolve) => {
      rl.question("Would you like to set up environment variables now? (Y/n): ", resolve)
    })
    if (answer.trim().toLowerCase() === "n") return initialProvider

    const selectedProvider = initialProvider ?? await (async () => {
      const realProviders = listProviders().filter((p) => p !== "fake" && p !== "openai-like")
      output.write("\nAvailable providers:\n")
      for (const p of realProviders) {
        output.write(`  ${p}\n`)
      }
      output.write("\n")
      const raw = await new Promise<string>((resolve) => {
        rl.question(`Select provider [${realProviders.join("/")}]: `, resolve)
      })
      const p = raw.trim().toLowerCase() || "deepseek"
      if (!hasProvider(p)) {
        output.write(`Unknown provider: ${p}. Skipping setup.\n`)
        return null as unknown as string
      }
      return p
    })()
    if (!hasProvider(selectedProvider)) return initialProvider

    const entries: Record<string, string> = { EASYCODE_PROVIDER: selectedProvider }

    if (selectedProvider === "deepseek") {
      if (!env.DEEPSEEK_API_KEY) {
        const apiKey = await new Promise<string>((resolve) => {
          rl.question("DeepSeek API key (sk): ", resolve)
        })
        if (apiKey.trim()) entries.DEEPSEEK_API_KEY = apiKey.trim()
      }
      if (!env.DEEPSEEK_MODEL && !env.EASYCODE_MODEL) {
        const model = await new Promise<string>((resolve) => {
          rl.question("DeepSeek model [deepseek-v4-pro]: ", resolve)
        })
        if (model.trim()) entries.DEEPSEEK_MODEL = model.trim()
      }
    } else if (selectedProvider === "openai") {
      if (!env.OPENAI_API_KEY) {
        const apiKey = await new Promise<string>((resolve) => {
          rl.question("OpenAI API key (sk-): ", resolve)
        })
        if (apiKey.trim()) entries.OPENAI_API_KEY = apiKey.trim()
      }
      if (!env.EASYCODE_MODEL) {
        const model = await new Promise<string>((resolve) => {
          rl.question("OpenAI model [gpt-5-mini]: ", resolve)
        })
        if (model.trim()) entries.EASYCODE_MODEL = model.trim()
      }
    } else if (selectedProvider === "openai-compatible") {
      if (!env.OPENAI_COMPAT_API_KEY) {
        const apiKey = await new Promise<string>((resolve) => {
          rl.question("OpenAI-compatible API key: ", resolve)
        })
        if (apiKey.trim()) entries.OPENAI_COMPAT_API_KEY = apiKey.trim()
      }
      if (!env.OPENAI_COMPAT_API_URL) {
        const url = await new Promise<string>((resolve) => {
          rl.question("OpenAI-compatible chat completions URL: ", resolve)
        })
        if (url.trim()) entries.OPENAI_COMPAT_API_URL = url.trim()
      }
      if (!env.OPENAI_COMPAT_MODEL && !env.EASYCODE_MODEL) {
        const model = await new Promise<string>((resolve) => {
          rl.question("OpenAI-compatible model: ", resolve)
        })
        if (model.trim()) entries.OPENAI_COMPAT_MODEL = model.trim()
      }
    }

    const envPath = path.join(os.homedir(), ".easycode", ".env")
    const existing = await Bun.file(envPath).text().catch(() => "# easycode configuration\n")
    await Bun.write(envPath, mergeEnvText(existing, entries))
    output.write(`\n✅ Configuration saved to ${envPath}\n`)

    // Reload env vars so they're available immediately
    await loadEnvFile(root, env)
    return selectedProvider
  } finally {
    rl.close()
  }
}

async function runOnce(args: ReturnType<typeof parseArgs>, loadedEnvVars = 0) {
  if (!args.prompt) throw new Error("Prompt is required")
  const logger = args.logger ? createLogger({ root: args.root, session: args.session ?? "once" }) : undefined
  emitLog(logger, { type: "data", name: "cli.args -> runner", detail: { mode: args.mode, provider: args.provider, root: args.root, session: args.session, once: args.once } })
  emitLog(logger, { type: "data", name: ".env -> process.env", detail: { loadedEnvVars } })
  const reader = new LineReader(createInterface({ input, output }))
  const settings = normalizeSessionSettings({ provider: args.provider, model: args.model, maxTokens: args.maxTokens, maxSteps: args.maxSteps }, args.provider)
  const tui = args.tui ? new TuiRenderer(output, { root: args.root, mode: args.mode, provider: settings.provider, model: settings.model, session: args.session ?? "once", logger: args.logger }) : undefined
  const timeline = tui ?? new TimelineRenderer(output)
  const onEvent = timelineEventHandler(timeline)
  try {
    const controller = new AbortController()
    const permission = permissionService(args.mode, reader, () => controller.abort(), tui)
    const result = await createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger, permission, settings, onEvent }).run(args.prompt, args.mode, { signal: controller.signal })
    timeline.finish()
    return result.status
  } finally {
    reader.close()
  }
}

async function runSession(args: ReturnType<typeof parseArgs>, loadedEnvVars = 0) {
  const store = new SessionStore(args.root)
  const reader = new LineReader(createInterface({ input, output }))
  const tui = args.tui ? new TuiRenderer(output, { root: args.root, mode: args.mode, provider: args.provider, model: args.model, session: args.session, logger: args.logger }) : undefined
  try {
    const session = await selectSession(args.session, store, reader, tui)
    if (!session) return "completed"
    tui?.startSession(session)
    const logger = args.logger ? createLogger({ root: args.root, session }) : undefined
    emitLog(logger, { type: "data", name: "cli.args -> runner", detail: { mode: args.mode, provider: args.provider, root: args.root, session, once: args.once } })
    emitLog(logger, { type: "data", name: ".env -> process.env", detail: { loadedEnvVars } })
    emitLog(logger, { type: "data", name: "session.selected", detail: { session } })
    const context = await store.context(session)
    const storedSettings = await store.settings(session, args.provider)
    let activeSettings = normalizeSessionSettings({ ...storedSettings, provider: args.providerExplicit ? args.provider : storedSettings.provider, model: args.model ?? storedSettings.model, maxTokens: args.maxTokens ?? storedSettings.maxTokens, maxSteps: args.maxSteps ?? storedSettings.maxSteps }, args.provider)
    if (!args.providerExplicit && !storedSettings.provider) activeSettings = normalizeSessionSettings({ provider: args.provider, model: args.model, maxTokens: args.maxTokens, maxSteps: args.maxSteps }, args.provider)
    const skillService = new SkillService(args.root)
    let pendingImages: ImagePart[] = []
    const queuedPrompts: string[] = []
    let activeMode = args.mode
    let runner: ReturnType<typeof createRunner> | undefined
    let activeAbort: AbortController | undefined
    tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, session })
    const timeline = tui ?? new TimelineRenderer(output)
    const onEvent = timelineEventHandler(timeline)
    let saveChain = Promise.resolve()
    const saveSession = (contextToSave: ContextManagerLike) => {
      saveChain = saveChain.then(() => store.save(session, contextToSave, activeSettings))
      return saveChain
    }
    const getRunner = () => {
      runner ??= createRunner({ root: args.root, provider: activeSettings.provider, mode: activeMode, logger, context, permission: permissionService(activeMode, reader, () => activeAbort?.abort(), tui), settings: activeSettings, onEvent, onBackgroundContextUpdate: () => saveSession(context) })
      return runner
    }
    while (true) {
      const prompt = (queuedPrompts.shift() ?? await question(reader, tui)).trim()
      if (prompt === eofPrompt) {
        await saveSession(runner?.context ?? context)
        return "completed"
      }
      if (["exit", ":exit", "quit", ":quit"].includes(prompt.toLowerCase())) {
        await saveSession(runner?.context ?? context)
        return "completed"
      }
      if (!prompt) continue
      const command = parseSlashCommand(prompt)
      if (command.type !== "prompt") {
        const changed = await handleSlashCommand(command, { root: args.root, settings: activeSettings, pendingImages, skills: skillService, sessions: store, currentSession: session, tui })
        activeSettings = changed.settings
        pendingImages = changed.pendingImages
        tui?.configure({ provider: activeSettings.provider, model: activeSettings.model, mode: activeMode, session })
        if (changed.resetRunner) runner = undefined
        await saveSession(runner?.context ?? context)
        continue
      }
      const activeRunner = getRunner()
      const images = pendingImages
      pendingImages = []
      activeAbort = new AbortController()
      const runInput = collectRunInput(reader, activeAbort, queuedPrompts, tui)
      const result = await activeRunner.run(command.text, activeMode, { images, signal: activeAbort.signal })
      runInput.stop()
      activeAbort = undefined
      timeline.finish()
      await saveSession(activeRunner.context)
      if (activeMode === "plan" && result.status === "completed" && hasProposedPlanText(result.text)) {
        savePlan(args.root, session, result.text).catch((err) => {
          emitLog(logger, { type: "error", name: "plan.save_failed", detail: { error: String(err) } })
          console.error("⚠️ Failed to save plan file:", err)
        })
        const choice = (await reader.question(
          tui?.planApprovalPrompt() ?? `[A]pprove & execute  [R]eject (stay in plan)  [E]dit plan  [N]ew prompt [A]: `
        )).trim().toLowerCase() || "a"
        if (choice === "r" || choice.startsWith("reject")) {
          // stay in plan mode
        } else if (choice === "e" || choice.startsWith("edit")) {
          const editDesc = await reader.question("What would you like changed? ")
          if (editDesc) queuedPrompts.push(`Revise the plan: ${editDesc}`)
        } else if (choice === "n" || choice.startsWith("new")) {
          // just continue, no mode change
        } else {
          // default: approve
          activeMode = "build"
          tui?.configure({ mode: activeMode }, "approved")
          runner = undefined
          queuedPrompts.push("Proceed with the approved plan.")
        }
      }
      if (result.status !== "completed") continue
    }
  } finally {
    reader.close()
  }
}

async function selectSession(explicitSession: string | undefined, store: SessionStore, reader: LineReader, tui?: TuiRenderer) {
  if (explicitSession) return explicitSession
  const sessions = await store.list()
  if (sessions.length === 0) {
    writeCliText(tui, "Starting new session: default", "Session")
    return "default"
  }
  const sessionLines = [
    "Select a session:",
    ...sessions.map((session, index) => `  ${index + 1}. ${session.id}${session.messageCount ? ` (${session.messageCount} messages)` : ""}`),
    "Press Enter for 1, enter a number, or type a new session id.",
  ]
  writeCliText(tui, sessionLines.join("\n"), "Sessions")
  while (true) {
    const answer = (await reader.question(tui?.sessionPrompt() ?? "session> ")).trim()
    if (answer === eofPrompt) return undefined
    if (!answer) return sessions[0].id
    const selectedIndex = Number(answer)
    if (Number.isInteger(selectedIndex)) {
      if (selectedIndex >= 1 && selectedIndex <= sessions.length) return sessions[selectedIndex - 1].id
      writeCliText(tui, `Choose 1-${sessions.length}, or type a non-numeric new session id.`, "Sessions")
      continue
    }
    return answer
  }
}

async function handleSlashCommand(command: Exclude<SlashCommand, { type: "prompt" }>, input: { root: string; settings: SessionSettings; pendingImages: ImagePart[]; skills: SkillService; sessions?: SessionStore; currentSession?: string; tui?: TuiRenderer }) {
  const next = { ...input.settings, selectedSkills: [...input.settings.selectedSkills] }
  let pendingImages = input.pendingImages
  let resetRunner = false
  input.tui?.slashCommand(command.type)
  const write = (text: string, title = "Command") => writeCliText(input.tui, text, title)
  if (command.type === "help") write(slashHelpText(), "Help")
  if (command.type === "settings") write(settingsText(next, pendingImages), "Settings")
  if (command.type === "sessions") write(await sessionsText(input.sessions, input.currentSession), "Sessions")
  if (command.type === "unknown") write(`Unknown command: /${command.name}. Use /help.`, "Command")
  if (command.type === "error") write(command.message, "Command")
  if (command.type === "model") {
    if (!hasProvider(command.provider)) write(`Unknown provider: ${command.provider}. Available providers: ${listProviders().join(", ")}`, "Model")
    else {
      next.provider = command.provider
      next.model = command.model
      resetRunner = true
      write(`Model set to ${next.provider}${next.model ? ` ${next.model}` : ""}`, "Model")
    }
  }
  if (command.type === "thinking") {
    const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
    if (!(provider.capabilities ?? defaultProviderCapabilities).supportsThinking) write(`Provider ${next.provider} does not support thinking controls.`, "Thinking")
    else {
      next.thinking = command.value === "on"
      resetRunner = true
      write(`${command.aliasUsed ? "Alias /thingking accepted; use /thinking next time. " : ""}Thinking ${next.thinking ? "on" : "off"}.`, "Thinking")
    }
  }
  if (command.type === "effort") {
    if (!isReasoningEffort(command.value)) write("/effort requires low, medium, high, or max", "Effort")
    else {
      const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
      if (!(provider.capabilities ?? defaultProviderCapabilities).supportsReasoningEffort) write(`Provider ${next.provider} does not support effort controls.`, "Effort")
      else {
        next.effort = command.value
        resetRunner = true
        write(`Effort set to ${next.effort}${next.thinking ? "" : " (applies when /thinking is on)"}.`, "Effort")
      }
    }
  }
  if (command.type === "image") {
    if (command.action === "clear") {
      pendingImages = []
      write("Pending images cleared.", "Image")
    } else {
      const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
      if (!(provider.capabilities ?? defaultProviderCapabilities).supportsImages) write(`Provider ${next.provider} does not support image input. Use /model openai with a vision-capable model.`, "Image")
      else {
        try {
          const part = await imagePartFromInput(command.value, input.root)
          pendingImages = [...pendingImages, part]
          write(`Attached image: ${imageLabel(part.source)}`, "Image")
        } catch (error) {
          write(error instanceof Error ? error.message : String(error), "Image")
        }
      }
    }
  }
  if (command.type === "skill") {
    if (command.action === "list") {
      const skills = await input.skills.available()
      const lines: string[] = []
      for (const skill of skills) {
        lines.push(`${skill.id}\n  name: ${skill.name} — ${skill.description}`)
      }
      write(skills.length === 0 ? "No skills found." : lines.join("\n"), "Skills")
    }
    if (command.action === "clear") {
      next.selectedSkills = []
      next.pendingSkillLoads = []
      resetRunner = true
      write("Active skills cleared.", "Skills")
    }
    if (command.action === "use") {
      const skill = await input.skills.load(command.name)
      if (!skill) write(`Skill not found: ${command.name}`, "Skills")
      else {
        next.selectedSkills = [...new Set([...next.selectedSkills, skill.id])]
        next.pendingSkillLoads = [...new Set([...(next.pendingSkillLoads ?? []), skill.id])]
        resetRunner = true
        write(`Skill active: ${skill.id}`, "Skills")
      }
    }
    if (command.action === "remove") {
      const removed = next.selectedSkills.filter((id) => id === command.name || id.endsWith(`/${command.name}`) || id.endsWith(`:${command.name}`))
      if (removed.length === 0) {
        write(`No active skill found: ${command.name}`, "Skills")
      } else {
        next.selectedSkills = next.selectedSkills.filter((id) => !removed.includes(id))
        next.pendingSkillLoads = (next.pendingSkillLoads ?? []).filter((id) => !removed.includes(id))
        resetRunner = true
        write(`Skill removed: ${removed.join(", ")}`, "Skills")
      }
    }
  }
  return { settings: next, pendingImages, resetRunner }
}

async function sessionsText(store: SessionStore | undefined, currentSession: string | undefined) {
  if (!store) return "No session store is active."
  const sessions = await store.list()
  if (sessions.length === 0) return "No saved sessions."
  return [
    "Saved sessions:",
    ...sessions.map((session, index) => {
      const current = session.id === currentSession ? " (current)" : ""
      const messages = session.messageCount === 1 ? "1 message" : `${session.messageCount} messages`
      return `  ${index + 1}. ${session.id}${current} - ${messages}`
    }),
  ].join("\n")
}

function settingsText(settings: SessionSettings, images: ImagePart[]) {
  return [
    `provider: ${settings.provider}`,
    `model: ${settings.model ?? "(provider default)"}`,
    `thinking: ${settings.thinking ? "on" : "off"}`,
    `effort: ${settings.effort}`,
    "cache: every-step",
    `maxTokens: ${settings.maxTokens}`,
    `maxSteps: ${settings.maxSteps}`,
    `skills: ${settings.selectedSkills.join(", ") || "(none)"}`,
    `pendingSkillLoads: ${settings.pendingSkillLoads.join(", ") || "(none)"}`,
    `pending images: ${images.length}`,
  ].join("\n")
}

function writeCliText(tui: TuiRenderer | undefined, text: string, title: string) {
  if (tui) {
    tui.panel(title, text)
    return
  }
  output.write(text.endsWith("\n") ? text : `${text}\n`)
}

function collectRunInput(reader: LineReader, activeAbort: AbortController, queuedPrompts: string[], tui?: TuiRenderer) {
  const pumpAbort = new AbortController()
  if (tui) tui.runInputHint()
  else output.write("Type /cancel to stop this run; other input will run next.\n")
  const done = (async () => {
    while (!pumpAbort.signal.aborted) {
      const line = await reader.nextLine("background", pumpAbort.signal)
      if (line === eofPrompt) break
      const text = line.trim()
      if (!text) continue
      if (isCancelInput(text)) {
        if (tui) tui.cancelling()
        else output.write("Cancelling current run...\n")
        activeAbort.abort()
        pumpAbort.abort()
        break
      }
      queuedPrompts.push(text)
      if (tui) tui.queued(shortPrompt(text))
      else output.write(`Queued next input: ${shortPrompt(text)}\n`)
    }
  })()
  return {
    stop: () => {
      pumpAbort.abort()
      void done
    },
  }
}

async function question(reader: LineReader, tui?: TuiRenderer) {
  return reader.question(tui?.inputPrompt() ?? "> ")
}

function permissionService(mode: AgentMode, reader: LineReader, cancelRun?: () => void, tui?: TuiRenderer) {
  return new PermissionService(defaultPermissionRules(mode), async (request) => {
    const basePrompt = permissionPrompt(request)
    const answer = (await questionWithPrompt(reader, tui?.permissionPrompt(request, basePrompt) ?? basePrompt)).trim().toLowerCase()
    if (answer === eofPrompt) return "reject"
    if (isCancelInput(answer)) {
      cancelRun?.()
      if (tui) tui.cancelling()
      else output.write("Cancelling current run...\n")
      return "reject"
    }
    if (answer === "a" || answer === "always") return "always"
    if (answer === "" || answer === "y" || answer === "yes" || answer === "once") return "once"
    return "reject"
  }, defaultPermissionAutoReviewer)
}

async function questionWithPrompt(reader: LineReader, prompt: string) {
  output.write(`${prompt}\n`)
  return reader.question("permission> ")
}

function isCancelInput(text: string) {
  return ["/cancel", "cancel", ":cancel", "stop", "/stop"].includes(text.trim().toLowerCase())
}

function shortPrompt(text: string) {
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`
}

function permissionPrompt(request: PermissionRequest) {
  const patterns = request.patterns.join(", ")
  const scope = typeof request.metadata.approvalScope === "string" ? `\nScope: ${request.metadata.approvalScope}` : ""
  if (request.permission === "bash" && typeof request.metadata.command === "string") {
    return `Allow bash for ${request.metadata.command}?${scope}\n[Y]es/[a]lways/[n]o`
  }
  if (request.permission === "sandbox_bypass") {
    const risk = typeof request.metadata.risk === "string" ? request.metadata.risk : "This command will be retried without the native write sandbox."
    const reason = typeof request.metadata.reason === "string" ? `Reason: ${request.metadata.reason}\n` : ""
    const command = typeof request.metadata.command === "string" ? request.metadata.command : patterns
    const failure = typeof request.metadata.failure === "string" && request.metadata.failure ? `\nFailure: ${request.metadata.failure}` : ""
    return `EasyCode sandbox blocked this command.
${reason}Risk: ${risk}
Command: ${command}${scope}${failure}
Allow sandbox bypass for this command? [Y]es/[a]lways/[n]o`
  }
  return `Allow ${request.permission} for ${patterns}? [Y]es/[a]lways/[n]o`
}

function timelineEventHandler(timeline: RunRenderer) {
  return (event: RunUiEvent) => {
    timeline.event(event)
  }
}
