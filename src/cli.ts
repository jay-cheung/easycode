#!/usr/bin/env bun
import path from "node:path"
import { createInterface } from "node:readline"
import { stdin as input, stdout as output } from "node:process"
import { createRunner } from "./agent"
import { imageLabel, imagePartFromInput } from "./image"
import { createLogger, emitLog, markStdoutText, type Logger } from "./logger"
import type { AgentMode, ImagePart } from "./message"
import { defaultPermissionRules, PermissionService, type PermissionRequest } from "./permission"
import { createProvider, defaultProviderCapabilities, hasProvider, listProviders, type ProviderName } from "./provider"
import { SessionStore } from "./session"
import { defaultSessionSettings, isCacheStrategy, isReasoningEffort, normalizeSessionSettings, type SessionSettings } from "./settings"
import { parseSlashCommand, slashHelpText, type SlashCommand } from "./slash"
import { SkillService } from "./skill"
import { TimelineRenderer } from "./ui/timeline"
import type { CacheStrategy } from "./cache-policy"

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
  const cacheStrategyIndex = argv.indexOf("--cache-strategy")
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
  const cacheStrategy: CacheStrategy | undefined = cacheStrategyIndex === -1 ? undefined : argv[cacheStrategyIndex + 1] as CacheStrategy
  if (cacheStrategyIndex !== -1 && (!cacheStrategy || cacheStrategy.startsWith("--") || !isCacheStrategy(cacheStrategy))) throw new Error("--cache-strategy requires auto, balanced, or cache-heavy")
  const maxTokens = numericFlag(argv, maxTokensIndex, "--max-tokens")
  const maxSteps = numericFlag(argv, maxStepsIndex, "--max-steps")
  const prompt = argv.slice(1).filter((arg, index, items) => {
    const realIndex = index + 1
    return !arg.startsWith("--") && realIndex !== providerIndex + 1 && realIndex !== rootIndex + 1 && realIndex !== sessionIndex + 1 && realIndex !== modelIndex + 1 && realIndex !== cacheStrategyIndex + 1 && realIndex !== maxTokensIndex + 1 && realIndex !== maxStepsIndex + 1 && items[realIndex - 1] !== "--provider" && items[realIndex - 1] !== "--root" && items[realIndex - 1] !== "--session" && items[realIndex - 1] !== "--model" && items[realIndex - 1] !== "--cache-strategy" && items[realIndex - 1] !== "--max-tokens" && items[realIndex - 1] !== "--max-steps"
  }).join(" ")
  if (!once && prompt) throw new Error("Session mode is interactive; use --once for startup prompts")
  return { mode: mode as AgentMode, prompt, provider, providerExplicit, model, cacheStrategy, maxTokens, maxSteps, root, logger, session: explicitSession ?? "default", once }
}

function usage() {
  return `Usage: easycode <build|plan> [--once prompt] [--provider ${listProviders().join("|")}] [--model id] [--cache-strategy auto|balanced|cache-heavy] [--max-tokens n] [--max-steps n] [--root path] [--logger] [--session id]`
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
  const args = parseArgs(process.argv.slice(2))
  const logger = args.logger ? createLogger() : undefined
  emitLog(logger, { type: "data", name: "cli.args -> runner", detail: { mode: args.mode, provider: args.provider, root: args.root, session: args.session, once: args.once } })
  const loadedEnvVars = await loadEnvFile(args.root)
  emitLog(logger, { type: "data", name: ".env -> process.env", detail: { loadedEnvVars } })
  const status = args.once ? await runOnce(args, logger) : await runSession(args, logger)
  process.exit(status === "completed" ? 0 : 1)
}

async function runOnce(args: ReturnType<typeof parseArgs>, logger: Logger | undefined) {
  if (!args.prompt) throw new Error("Prompt is required")
  const reader = new LineReader(createInterface({ input, output }))
  const settings = normalizeSessionSettings({ provider: args.provider, model: args.model, cacheStrategy: args.cacheStrategy, maxTokens: args.maxTokens, maxSteps: args.maxSteps }, args.provider)
  const timeline = logger ? undefined : new TimelineRenderer(output)
  try {
    const controller = new AbortController()
    const permission = permissionService(args.mode, reader, () => controller.abort())
    const result = await createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger, permission, settings, onTextDelta: logger ? textDeltaWriter() : undefined, onEvent: timeline ? (event) => timeline.event(event) : undefined }).run(args.prompt, args.mode, { signal: controller.signal })
    timeline?.finish()
    if (logger) writeResult(result.text, true)
    return result.status
  } finally {
    reader.close()
  }
}

async function runSession(args: ReturnType<typeof parseArgs>, logger: Logger | undefined) {
  const store = new SessionStore(args.root)
  const context = await store.context(args.session ?? "")
  const storedSettings = await store.settings(args.session ?? "", args.provider)
  let activeSettings = normalizeSessionSettings({ ...storedSettings, provider: args.providerExplicit ? args.provider : storedSettings.provider, model: args.model ?? storedSettings.model, cacheStrategy: args.cacheStrategy ?? storedSettings.cacheStrategy, maxTokens: args.maxTokens ?? storedSettings.maxTokens, maxSteps: args.maxSteps ?? storedSettings.maxSteps }, args.provider)
  if (!args.providerExplicit && !storedSettings.provider) activeSettings = normalizeSessionSettings({ provider: args.provider, model: args.model, cacheStrategy: args.cacheStrategy, maxTokens: args.maxTokens, maxSteps: args.maxSteps }, args.provider)
  const skillService = new SkillService(args.root)
  let pendingImages: ImagePart[] = []
  const queuedPrompts: string[] = []
  let activeMode = args.mode
  let runner: ReturnType<typeof createRunner> | undefined
  const reader = new LineReader(createInterface({ input, output }))
  let activeAbort: AbortController | undefined
  const getRunner = () => {
    runner ??= createRunner({ root: args.root, provider: activeSettings.provider, mode: activeMode, logger, context, permission: permissionService(activeMode, reader, () => activeAbort?.abort()), settings: activeSettings, onTextDelta: logger ? textDeltaWriter() : undefined, onEvent: logger ? undefined : (event) => timeline.event(event) })
    return runner
  }
  const timeline = new TimelineRenderer(output)
  try {
    while (true) {
      const prompt = (queuedPrompts.shift() ?? await question(reader)).trim()
      if (prompt === eofPrompt) {
        await store.save(args.session ?? "", runner?.context ?? context, activeSettings)
        return "completed"
      }
      if (["exit", ":exit", "quit", ":quit"].includes(prompt.toLowerCase())) {
        await store.save(args.session ?? "", runner?.context ?? context, activeSettings)
        return "completed"
      }
      if (!prompt) continue
      const command = parseSlashCommand(prompt)
      if (command.type !== "prompt") {
        const changed = await handleSlashCommand(command, { root: args.root, settings: activeSettings, pendingImages, skills: skillService })
        activeSettings = changed.settings
        pendingImages = changed.pendingImages
        if (changed.resetRunner) runner = undefined
        await store.save(args.session ?? "", runner?.context ?? context, activeSettings)
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
      if (logger) writeResult(result.text, true)
      await store.save(args.session ?? "", activeRunner.context, activeSettings)
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
  if (command.type === "cache") {
    if (!isCacheStrategy(command.value)) output.write("/cache requires auto, balanced, or cache-heavy\n")
    else {
      next.cacheStrategy = command.value
      resetRunner = true
      output.write(`Cache strategy set to ${next.cacheStrategy}.\n`)
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
      output.write(`${skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n") || "No skills found."}\n`)
    }
    if (command.action === "clear") {
      next.selectedSkills = []
      resetRunner = true
      output.write("Active skills cleared.\n")
    }
    if (command.action === "use") {
      const skill = await input.skills.load(command.name)
      if (!skill) output.write(`Skill not found: ${command.name}\n`)
      else {
        next.selectedSkills = [...new Set([...next.selectedSkills, skill.name])]
        resetRunner = true
        output.write(`Skill active: ${skill.name}\n`)
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
    `cache: ${settings.cacheStrategy}`,
    `maxTokens: ${settings.maxTokens}`,
    `maxSteps: ${settings.maxSteps}`,
    `skills: ${settings.selectedSkills.join(", ") || "(none)"}`,
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
  })
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

function textDeltaWriter() {
  return (text: string) => {
    process.stdout.write(text)
    markStdoutText(text)
  }
}

function writeResult(text: string, loggerEnabled: boolean) {
  if (text && !text.endsWith("\n")) {
    process.stdout.write("\n")
    markStdoutText("\n")
  }
}
