import path from "node:path"
import os from "node:os"
import { mkdir, readdir, rm } from "node:fs/promises"
import { AgentRunner, createRunner } from "./agent"
import type { AgentMode } from "./message"
import { createProvider, hasProvider, listProviders, type ProviderName } from "./provider"
import { createLogger } from "./logger"
import type { ToolContext, ToolRegistryLike, ToolResult } from "./tool"
import { loadEnvFile } from "./cli"

export type EvalTask = {
  id: string
  mode: AgentMode
  prompt: string
  fixture: string
  providers?: ProviderName[]
  tools?: "builtin" | "none"
  expected: {
    status: "passed"
    changedFiles?: string[]
    forbiddenFiles?: string[]
    requiredTools?: string[]
    maxToolCalls?: number
    outputContains?: string[]
  }
}

const emptyRegistry: ToolRegistryLike = {
  get: () => undefined,
  list: () => [],
  run: async (name: string, _input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({
    title: "Unexpected tool",
    output: `Unexpected tool call: ${name}`,
    metadata: { status: "failed" },
  }),
}

async function copyDir(from: string, to: string) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) {
      await copyDir(source, target)
      continue
    }
    await Bun.write(target, await Bun.file(source).arrayBuffer())
  }
}

async function snapshotFiles(root: string) {
  const out = new Map<string, string>()
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      out.set(path.relative(root, full), await Bun.file(full).text().catch(() => ""))
    }
  }
  await walk(root)
  return out
}

type EvalProvider = ProviderName

export async function runEval(input: { provider: EvalProvider; root?: string }) {
  const projectRoot = input.root ?? path.resolve(import.meta.dir, "..")
  await loadEnvFile(projectRoot)
  const taskDir = path.join(projectRoot, "evals", "tasks")
  const tasks = (await readdir(taskDir)).filter((file) => file.endsWith(".json")).sort((left, right) => left.localeCompare(right))
  const results: { id: string; passed: boolean; skipped?: boolean; reason?: string }[] = []
  for (const file of tasks) {
    const task = JSON.parse(await Bun.file(path.join(taskDir, file)).text()) as EvalTask
    const providers = task.providers ?? ["fake"]
    if (!providers.includes(input.provider)) {
      results.push({ id: task.id, passed: true, skipped: true, reason: `not configured for provider ${input.provider}` })
      continue
    }
    const workdir = path.join(os.tmpdir(), `easycode-${task.id}-${Date.now()}`)
    await copyDir(path.join(projectRoot, task.fixture), workdir)
    const before = await snapshotFiles(workdir)
    const result = task.tools === "none"
      ? await new AgentRunner({ root: workdir, provider: createProvider(input.provider), registry: emptyRegistry, logger: createLogger() }).run(task.prompt, task.mode)
      : await createRunner({ root: workdir, provider: input.provider, mode: task.mode, logger: createLogger() }).run(task.prompt, task.mode)
    const after = await snapshotFiles(workdir)
    const missingTool = task.expected.requiredTools?.find((tool) => !result.usedTools.includes(tool))
    const tooManyTools = task.expected.maxToolCalls !== undefined && result.usedTools.length > task.expected.maxToolCalls
    const missingChange = task.expected.changedFiles?.find((filePath) => before.get(filePath) === after.get(filePath))
    const forbiddenChange = task.expected.forbiddenFiles?.find((filePath) => before.get(filePath) !== after.get(filePath))
    const missingOutput = task.expected.outputContains?.find((text) => !result.text.toLowerCase().includes(text.toLowerCase()))
    const passed = result.status === "completed" && !missingTool && !tooManyTools && !missingChange && !forbiddenChange && !missingOutput
    results.push({ id: task.id, passed, reason: missingTool ? `missing tool ${missingTool}` : tooManyTools ? "too many tool calls" : missingChange ? `missing expected change ${missingChange}` : forbiddenChange ? `forbidden file changed ${forbiddenChange}` : missingOutput ? `missing output ${missingOutput}` : undefined })
    await rm(workdir, { recursive: true, force: true })
  }
  return results
}

if (import.meta.main) {
  const provider = process.argv.includes("--provider") ? process.argv[process.argv.indexOf("--provider") + 1] : "fake"
  if (!hasProvider(provider)) throw new Error(`Unknown provider: ${provider}. Available providers: ${listProviders().join(", ")}`)
  const results = await runEval({ provider })
  for (const result of results) console.log(`${result.skipped ? "SKIP" : result.passed ? "PASS" : "FAIL"} ${result.id}${result.reason ? ` - ${result.reason}` : ""}`)
  if (results.some((result) => !result.skipped && !result.passed)) process.exit(1)
}
