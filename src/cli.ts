#!/usr/bin/env bun
import path from "node:path"
import { createRunner } from "./agent"
import { createLogger, emitLog } from "./logger"
import type { AgentMode } from "./message"

type EnvTarget = {
  [key: string]: string | undefined
}

function parseArgs(argv: string[]) {
  const mode = argv[0]
  if (mode !== "build" && mode !== "plan") throw new Error("Usage: easycode <build|plan> <prompt> [--provider fake|openai] [--root path] [--logger]")
  const providerIndex = argv.indexOf("--provider")
  const rootIndex = argv.indexOf("--root")
  const logger = argv.includes("--logger")
  const rawProvider = providerIndex === -1 ? "fake" : argv[providerIndex + 1]
  if (rawProvider !== "fake" && rawProvider !== "openai") throw new Error(`Unknown provider: ${rawProvider}`)
  const provider: "fake" | "openai" = rawProvider
  const root = rootIndex === -1 ? process.cwd() : path.resolve(argv[rootIndex + 1])
  const prompt = argv.slice(1).filter((arg, index, items) => {
    const realIndex = index + 1
    return !arg.startsWith("--") && realIndex !== providerIndex + 1 && realIndex !== rootIndex + 1 && items[realIndex - 1] !== "--provider" && items[realIndex - 1] !== "--root"
  }).join(" ")
  if (!prompt) throw new Error("Prompt is required")
  return { mode: mode as AgentMode, prompt, provider, root, logger }
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
  const result = await createRunner({ root: args.root, provider: args.provider, mode: args.mode, logger }).run(args.prompt, args.mode)
  console.log(result.text)
  process.exit(result.status === "completed" ? 0 : 1)
}
