#!/usr/bin/env bun
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { createRunner } from "./agent"
import { createLogger, emitLog, type Logger } from "./logger"
import type { AgentMode } from "./message"
import { hasProvider, listProviders, type ProviderName } from "./provider"
import { SessionStore } from "./session"

type EnvTarget = {
  [key: string]: string | undefined
}

function parseArgs(argv: string[]) {
  const mode = argv[0]
  if (mode !== "build" && mode !== "plan") throw new Error(usage())
  const providerIndex = argv.indexOf("--provider")
  const rootIndex = argv.indexOf("--root")
  const sessionIndex = argv.indexOf("--session")
  const logger = argv.includes("--logger")
  const rawProvider = providerIndex === -1 ? "fake" : argv[providerIndex + 1]
  if (!hasProvider(rawProvider)) throw new Error(`Unknown provider: ${rawProvider}. Available providers: ${listProviders().join(", ")}`)
  const provider = rawProvider
  const root = rootIndex === -1 ? process.cwd() : path.resolve(argv[rootIndex + 1])
  const session = sessionIndex === -1 ? undefined : argv[sessionIndex + 1]
  if (sessionIndex !== -1 && (!session || session.startsWith("--"))) throw new Error("--session requires an id")
  const prompt = argv.slice(1).filter((arg, index, items) => {
    const realIndex = index + 1
    return !arg.startsWith("--") && realIndex !== providerIndex + 1 && realIndex !== rootIndex + 1 && realIndex !== sessionIndex + 1 && items[realIndex - 1] !== "--provider" && items[realIndex - 1] !== "--root" && items[realIndex - 1] !== "--session"
  }).join(" ")
  return { mode: mode as AgentMode, prompt, provider, root, logger, session }
}

function usage() {
  return `Usage: easycode <build|plan> [prompt] [--provider ${listProviders().join("|")}] [--root path] [--logger] [--session id]`
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
  emitLog(logger, { type: "data", name: "cli.args -> runner", detail: { mode: args.mode, provider: args.provider, root: args.root } })
  const loadedEnvVars = await loadEnvFile(args.root)
  emitLog(logger, { type: "data", name: ".env -> process.env", detail: { loadedEnvVars } })
  const status = args.session ? await runSession(args, logger) : await runOnce(args, logger)
  process.exit(status === "completed" ? 0 : 1)
}

async function runOnce(args: ReturnType<typeof parseArgs>, logger: Logger | undefined) {
  if (!args.prompt) throw new Error("Prompt is required")
  const result = await createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger, onTextDelta: textDeltaWriter(logger) }).run(args.prompt, args.mode)
  writeResult(result.text, Boolean(logger))
  return result.status
}

async function runSession(args: ReturnType<typeof parseArgs>, logger: Logger | undefined) {
  const store = new SessionStore(args.root)
  const context = await store.context(args.session ?? "")
  const runner = createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger, context, onTextDelta: textDeltaWriter(logger) })
  if (args.prompt) {
    const result = await runner.run(args.prompt, args.mode)
    writeResult(result.text, Boolean(logger))
    await store.save(args.session ?? "", runner.context)
    return result.status
  }

  const rl = createInterface({ input, output })
  try {
    while (true) {
      const prompt = (await rl.question("> ")).trim()
      if (["exit", ":exit", "quit", ":quit"].includes(prompt.toLowerCase())) {
        await store.save(args.session ?? "", runner.context)
        return "completed"
      }
      if (!prompt) continue
      const result = await runner.run(prompt, args.mode)
      writeResult(result.text, Boolean(logger))
      await store.save(args.session ?? "", runner.context)
      if (result.status !== "completed") return result.status
    }
  } finally {
    rl.close()
  }
}

function textDeltaWriter(logger: Logger | undefined) {
  if (logger) return undefined
  return (text: string) => process.stdout.write(text)
}

function writeResult(text: string, loggerEnabled: boolean) {
  if (loggerEnabled && text) process.stdout.write(text)
  if (text && !text.endsWith("\n")) process.stdout.write("\n")
}
