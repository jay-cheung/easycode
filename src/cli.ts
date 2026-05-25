#!/usr/bin/env bun
import path from "node:path"
import { createInterface } from "node:readline"
import { stdin as input, stdout as output } from "node:process"
import { createRunner } from "./agent"
import { imageLabel, imagePartFromInput } from "./image"
import { createLogger, emitLog } from "./logger"
import type { AgentMode, ImagePart } from "./message"
import { defaultPermissionAutoReviewer, defaultPermissionRules, PermissionService, type PermissionRequest } from "./permission"
import { createProvider, defaultProviderCapabilities, hasProvider, listProviders } from "./provider"
import { SessionStore } from "./session"
import { isReasoningEffort, normalizeSessionSettings, type SessionSettings } from "./settings"
import { parseSlashCommand, slashHelpText, type SlashCommand } from "./slash"
import { SkillService } from "./skill"
import { TimelineRenderer, type RunUiEvent } from "./ui/timeline"

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
  const mode = argv[0]
  if (mode !== "build" && mode !== "plan") throw new Error(usage())
  const providerIndex = argv.indexOf("--provider")
  const rootIndex = argv.indexOf("--root")
  const sessionIndex = argv.indexOf("--session")
  const modelIndex = argv.indexOf("--model")
  const maxTokensIndex = argv.indexOf("--max-tokens")
  const maxStepsIndex = argv.indexOf("--max-steps")
  const once = argv.includes("--once")
  const logger = argv.includes("--logger")
  const providerExplicit = providerIndex !== -1
  const rawProvider = providerIndex === -1 ? "fake" : argv[providerIndex + 1]
  if (!hasProvider(rawProvider)) throw new Error(`Unknown provider: ${rawProvider}. Available providers: ${listProviders().join(", ")}`)
  const provider = rawProvider
  const root = rootIndex === -1 ? process.cwd() : path.resolve(argv[rootIndex + 1])
  const explicitSession = sessionIndex === -1 ? undefined : argv[sessionIndex + 1]
  if (sessionIndex !== -1 && (!explicitSession || explicitSession.startsWith("--"))) throw new Error("--session requires an id")
  const model = modelIndex === -1 ? undefined : argv[modelIndex + 1]
  if (modelIndex !== -1 && (!model || model.startsWith("--"))) throw new Error("--model requires an id")
  const maxTokens = numericFlag(argv, maxTokensIndex, "--max-tokens")
  const maxSteps = numericFlag(argv, maxStepsIndex, "--max-steps")
  const prompt = argv.slice(1).filter((arg, index, items) => {
    const realIndex = index + 1
    return !arg.startsWith("--") && realIndex !== providerIndex + 1 && realIndex !== rootIndex + 1 && realIndex !== sessionIndex + 1 && realIndex !== modelIndex + 1 && realIndex !== maxTokensIndex + 1 && realIndex !== maxStepsIndex + 1 && items[realIndex - 1] !== "--provider" && items[realIndex - 1] !== "--root" && items[realIndex - 1] !== "--session" && items[realIndex - 1] !== "--model" && items[realIndex - 1] !== "--max-tokens" && items[realIndex - 1] !== "--max-steps"
  }).join(" ")
  if (!once && prompt) throw new Error("Session mode is interactive; use --once for startup prompts")
  return { mode: mode as AgentMode, prompt, provider, providerExplicit, model, maxTokens, maxSteps, root, logger, session: explicitSession, once }
}

function usage() {
  return `Usage: easycode <build|plan> [--once prompt] [--provider ${listProviders().join("|")}] [--model id] [--max-tokens n] [--max-steps n] [--root path] [--logger] [--session id]`
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
  const filePath = path.join(root, ".env")
  const file = Bun.file(filePath)
  if (!(await file.exists())) return 0
  let loaded = 0
  for (const [key, value] of parseEnvFile(await file.text())) {
    if (env[key] !== undefined) continue
    env[key] = value
    loaded += 1
  }
  return loaded
}

if (import.meta.main) {
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
  process.exit(status === "completed" ? 0 : 1)
}

export function requiredEnvForProvider(provider: string) {
  if (provider === "deepseek") return ["DEEPSEEK_API_KEY"]
  if (provider === "openai") return ["OPENAI_API_KEY"]
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
    }

    const envPath = path.join(root, ".env")
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
  const timeline = new TimelineRenderer(output)
  const onEvent = timelineEventHandler(timeline)
  try {
    const controller = new AbortController()
    const permission = permissionService(args.mode, reader, () => controller.abort())
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
  try {
    const session = await selectSession(args.session, store, reader)
    if (!session) return "completed"
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
    const timeline = new TimelineRenderer(output)
    const onEvent = timelineEventHandler(timeline)
    const getRunner = () => {
      runner ??= createRunner({ root: args.root, provider: activeSettings.provider, mode: activeMode, logger, context, permission: permissionService(activeMode, reader, () => activeAbort?.abort()), settings: activeSettings, onEvent })
      return runner
    }
    while (true) {
      const prompt = (queuedPrompts.shift() ?? await question(reader)).trim()
      if (prompt === eofPrompt) {
        await store.save(session, runner?.context ?? context, activeSettings)
        return "completed"
      }
      if (["exit", ":exit", "quit", ":quit"].includes(prompt.toLowerCase())) {
        await store.save(session, runner?.context ?? context, activeSettings)
        return "completed"
      }
      if (!prompt) continue
      const command = parseSlashCommand(prompt)
      if (command.type !== "prompt") {
        const changed = await handleSlashCommand(command, { root: args.root, settings: activeSettings, pendingImages, skills: skillService })
        activeSettings = changed.settings
        pendingImages = changed.pendingImages
        if (changed.resetRunner) runner = undefined
        await store.save(session, runner?.context ?? context, activeSettings)
        continue
      }
      const activeRunner = getRunner()
      const images = pendingImages
      pendingImages = []
      activeAbort = new AbortController()
      const runInput = collectRunInput(reader, activeAbort, queuedPrompts)
      const result = await activeRunner.run(command.text, activeMode, { images, signal: activeAbort.signal })
      runInput.stop()
      activeAbort = undefined
      timeline.finish()
      await store.save(session, activeRunner.context, activeSettings)
      if (activeMode === "plan" && result.status === "completed" && hasProposedPlan(result.text)) {
        activeMode = "build"
        runner = undefined
      }
      if (result.status !== "completed") continue
    }
  } finally {
    reader.close()
  }
}

async function selectSession(explicitSession: string | undefined, store: SessionStore, reader: LineReader) {
  if (explicitSession) return explicitSession
  const sessions = await store.list()
  if (sessions.length === 0) {
    output.write("Starting new session: default\n")
    return "default"
  }
  output.write("Select a session:\n")
  sessions.forEach((session, index) => {
    output.write(`  ${index + 1}. ${session.id}${session.messageCount ? ` (${session.messageCount} messages)` : ""}\n`)
  })
  output.write("Press Enter for 1, enter a number, or type a new session id.\n")
  while (true) {
    const answer = (await reader.question("session> ")).trim()
    if (answer === eofPrompt) return undefined
    if (!answer) return sessions[0].id
    const selectedIndex = Number(answer)
    if (Number.isInteger(selectedIndex)) {
      if (selectedIndex >= 1 && selectedIndex <= sessions.length) return sessions[selectedIndex - 1].id
      output.write(`Choose 1-${sessions.length}, or type a non-numeric new session id.\n`)
      continue
    }
    return answer
  }
}

async function handleSlashCommand(command: Exclude<SlashCommand, { type: "prompt" }>, input: { root: string; settings: SessionSettings; pendingImages: ImagePart[]; skills: SkillService }) {
  const next = { ...input.settings, selectedSkills: [...input.settings.selectedSkills] }
  let pendingImages = input.pendingImages
  let resetRunner = false
  if (command.type === "help") output.write(`${slashHelpText()}\n`)
  if (command.type === "settings") output.write(`${settingsText(next, pendingImages)}\n`)
  if (command.type === "unknown") output.write(`Unknown command: /${command.name}. Use /help.\n`)
  if (command.type === "error") output.write(`${command.message}\n`)
  if (command.type === "model") {
    if (!hasProvider(command.provider)) output.write(`Unknown provider: ${command.provider}. Available providers: ${listProviders().join(", ")}\n`)
    else {
      next.provider = command.provider
      next.model = command.model
      resetRunner = true
      output.write(`Model set to ${next.provider}${next.model ? ` ${next.model}` : ""}\n`)
    }
  }
  if (command.type === "thinking") {
    const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
    if (!(provider.capabilities ?? defaultProviderCapabilities).supportsThinking) output.write(`Provider ${next.provider} does not support thinking controls.\n`)
    else {
      next.thinking = command.value === "on"
      resetRunner = true
      output.write(`${command.aliasUsed ? "Alias /thingking accepted; use /thinking next time. " : ""}Thinking ${next.thinking ? "on" : "off"}.\n`)
    }
  }
  if (command.type === "effort") {
    if (!isReasoningEffort(command.value)) output.write("/effort requires low, medium, high, or max\n")
    else {
      const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
      if (!(provider.capabilities ?? defaultProviderCapabilities).supportsReasoningEffort) output.write(`Provider ${next.provider} does not support effort controls.\n`)
      else {
        next.effort = command.value
        resetRunner = true
        output.write(`Effort set to ${next.effort}${next.thinking ? "" : " (applies when /thinking is on)"}.\n`)
      }
    }
  }
  if (command.type === "image") {
    if (command.action === "clear") {
      pendingImages = []
      output.write("Pending images cleared.\n")
    } else {
      const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
      if (!(provider.capabilities ?? defaultProviderCapabilities).supportsImages) output.write(`Provider ${next.provider} does not support image input. Use /model openai with a vision-capable model.\n`)
      else {
        try {
          const part = await imagePartFromInput(command.value, input.root)
          pendingImages = [...pendingImages, part]
          output.write(`Attached image: ${imageLabel(part.source)}\n`)
        } catch (error) {
          output.write(`${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
    }
  }
  if (command.type === "skill") {
    if (command.action === "list") {
      const skills = await input.skills.available()
      for (const skill of skills) {
        output.write(`${skill.id}\n  name: ${skill.name} — ${skill.description}\n`)
      }
      if (skills.length === 0) output.write("No skills found.\n")
    }
    if (command.action === "clear") {
      next.selectedSkills = []
      next.pendingSkillLoads = []
      resetRunner = true
      output.write("Active skills cleared.\n")
    }
    if (command.action === "use") {
      const skill = await input.skills.load(command.name)
      if (!skill) output.write(`Skill not found: ${command.name}\n`)
      else {
        next.selectedSkills = [...new Set([...next.selectedSkills, skill.id])]
        next.pendingSkillLoads = [...new Set([...(next.pendingSkillLoads ?? []), skill.id])]
        resetRunner = true
        output.write(`Skill active: ${skill.id}\n`)
      }
    }
    if (command.action === "remove") {
      const removed = next.selectedSkills.filter((id) => id === command.name || id.endsWith(`/${command.name}`) || id.endsWith(`:${command.name}`))
      if (removed.length === 0) {
        output.write(`No active skill found: ${command.name}\n`)
      } else {
        next.selectedSkills = next.selectedSkills.filter((id) => !removed.includes(id))
        next.pendingSkillLoads = (next.pendingSkillLoads ?? []).filter((id) => !removed.includes(id))
        resetRunner = true
        output.write(`Skill removed: ${removed.join(", ")}\n`)
      }
    }
  }
  return { settings: next, pendingImages, resetRunner }
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

function hasProposedPlan(text: string) {
  return /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(text)
}

function collectRunInput(reader: LineReader, activeAbort: AbortController, queuedPrompts: string[]) {
  const pumpAbort = new AbortController()
  output.write("Type /cancel to stop this run; other input will run next.\n")
  const done = (async () => {
    while (!pumpAbort.signal.aborted) {
      const line = await reader.nextLine("background", pumpAbort.signal)
      if (line === eofPrompt) break
      const text = line.trim()
      if (!text) continue
      if (isCancelInput(text)) {
        output.write("Cancelling current run...\n")
        activeAbort.abort()
        pumpAbort.abort()
        break
      }
      queuedPrompts.push(text)
      output.write(`Queued next input: ${shortPrompt(text)}\n`)
    }
  })()
  return {
    stop: () => {
      pumpAbort.abort()
      void done
    },
  }
}

async function question(reader: LineReader) {
  return reader.question("> ")
}

function permissionService(mode: AgentMode, reader: LineReader, cancelRun?: () => void) {
  return new PermissionService(defaultPermissionRules(mode), async (request) => {
    const answer = (await questionWithPrompt(reader, permissionPrompt(request))).trim().toLowerCase()
    if (answer === eofPrompt) return "reject"
    if (isCancelInput(answer)) {
      cancelRun?.()
      output.write("Cancelling current run...\n")
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

function timelineEventHandler(timeline: TimelineRenderer) {
  return (event: RunUiEvent) => {
    timeline.event(event)
  }
}
