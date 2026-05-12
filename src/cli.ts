#!/usr/bin/env bun
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { createRunner } from "./agent"
import { createLogger, emitLog, type Logger } from "./logger"
import type { AgentMode } from "./message"
import { defaultPermissionRules, PermissionService, type PermissionRequest } from "./permission"
import { hasProvider, listProviders, type ProviderName } from "./provider"
import { SessionStore } from "./session"

type EnvTarget = {
  [key: string]: string | undefined
}

const eofPrompt = "\0__easycode_eof__"

export function parseArgs(argv: string[]) {
  const mode = argv[0]
  if (mode !== "build" && mode !== "plan") throw new Error(usage())
  const providerIndex = argv.indexOf("--provider")
  const rootIndex = argv.indexOf("--root")
  const sessionIndex = argv.indexOf("--session")
  const once = argv.includes("--once")
  const logger = argv.includes("--logger")
  const rawProvider = providerIndex === -1 ? "fake" : argv[providerIndex + 1]
  if (!hasProvider(rawProvider)) throw new Error(`Unknown provider: ${rawProvider}. Available providers: ${listProviders().join(", ")}`)
  const provider = rawProvider
  const root = rootIndex === -1 ? process.cwd() : path.resolve(argv[rootIndex + 1])
  const explicitSession = sessionIndex === -1 ? undefined : argv[sessionIndex + 1]
  if (sessionIndex !== -1 && (!explicitSession || explicitSession.startsWith("--"))) throw new Error("--session requires an id")
  const prompt = argv.slice(1).filter((arg, index, items) => {
    const realIndex = index + 1
    return !arg.startsWith("--") && realIndex !== providerIndex + 1 && realIndex !== rootIndex + 1 && realIndex !== sessionIndex + 1 && items[realIndex - 1] !== "--provider" && items[realIndex - 1] !== "--root" && items[realIndex - 1] !== "--session"
  }).join(" ")
  if (!once && prompt) throw new Error("Session mode is interactive; use --once for startup prompts")
  return { mode: mode as AgentMode, prompt, provider, root, logger, session: explicitSession ?? "default", once }
}

function usage() {
  return `Usage: easycode <build|plan> [--once prompt] [--provider ${listProviders().join("|")}] [--root path] [--logger] [--session id]`
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
  const rl = createInterface({ input, output })
  try {
    const permission = permissionService(args.mode, rl)
    const result = await createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger, permission, onTextDelta: textDeltaWriter(logger) }).run(args.prompt, args.mode)
    writeResult(result.text, Boolean(logger))
    return result.status
  } finally {
    rl.close()
  }
}

async function runSession(args: ReturnType<typeof parseArgs>, logger: Logger | undefined) {
  const store = new SessionStore(args.root)
  const context = await store.context(args.session ?? "")
  let activeMode = args.mode
  let runner: ReturnType<typeof createRunner> | undefined
  const rl = createInterface({ input, output })
  const getRunner = () => {
    runner ??= createRunner({ root: args.root, provider: args.provider, mode: activeMode, logger, context, permission: permissionService(activeMode, rl), onTextDelta: textDeltaWriter(logger) })
    return runner
  }
  try {
    while (true) {
      const prompt = (await question(rl)).trim()
      if (prompt === eofPrompt) {
        await store.save(args.session ?? "", runner?.context ?? context)
        return "completed"
      }
      if (["exit", ":exit", "quit", ":quit"].includes(prompt.toLowerCase())) {
        await store.save(args.session ?? "", runner?.context ?? context)
        return "completed"
      }
      if (!prompt) continue
      const activeRunner = getRunner()
      const result = await activeRunner.run(prompt, activeMode)
      writeResult(result.text, Boolean(logger))
      await store.save(args.session ?? "", activeRunner.context)
      if (activeMode === "plan" && result.status === "completed" && hasProposedPlan(result.text)) {
        activeMode = "build"
        runner = undefined
      }
      if (result.failureReason === "max_steps") continue
      if (result.status !== "completed") return result.status
    }
  } finally {
    rl.close()
  }
}

function hasProposedPlan(text: string) {
  return /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(text)
}

async function question(rl: ReturnType<typeof createInterface>) {
  try {
    return await rl.question("> ")
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
    if (code === "ERR_USE_AFTER_CLOSE") return eofPrompt
    throw error
  }
}

function permissionService(mode: AgentMode, rl: ReturnType<typeof createInterface>) {
  return new PermissionService(defaultPermissionRules(mode), async (request) => {
    const answer = (await questionWithPrompt(rl, permissionPrompt(request))).trim().toLowerCase()
    if (answer === eofPrompt) return "reject"
    if (answer === "a" || answer === "always") return "always"
    if (answer === "" || answer === "y" || answer === "yes" || answer === "once") return "once"
    return "reject"
  })
}

async function questionWithPrompt(rl: ReturnType<typeof createInterface>, prompt: string) {
  try {
    output.write(`${prompt}\n`)
    return await rl.question("permission> ")
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
    if (code === "ERR_USE_AFTER_CLOSE") return eofPrompt
    throw error
  }
}

function permissionPrompt(request: PermissionRequest) {
  const patterns = request.patterns.join(", ")
  return `Allow ${request.permission} for ${patterns}? [Y]es/[a]lways/[n]o`
}

function textDeltaWriter(logger: Logger | undefined) {
  if (logger) return undefined
  return (text: string) => process.stdout.write(text)
}

function writeResult(text: string, loggerEnabled: boolean) {
  if (loggerEnabled && text) process.stdout.write(text)
  if (text && !text.endsWith("\n")) process.stdout.write("\n")
}
