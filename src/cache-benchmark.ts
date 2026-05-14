import path from "node:path"
import os from "node:os"
import { mkdir, readdir, rm } from "node:fs/promises"
import { AgentRunner } from "./agent"
import { defaultCachePricing, type CacheStrategy, type StaticContextStrategy } from "./cache-policy"
import { ContextManager, estimateTextTokens } from "./context"
import { loadEnvFile } from "./cli"
import type { AgentMode, Message } from "./message"
import { defaultPermissionRules, PermissionService } from "./permission"
import { createProvider, defaultProviderCapabilities, hasProvider, listProviders, type Provider, type ProviderCapabilities, type ProviderEvent, type ProviderInput, type ProviderName } from "./provider"
import { normalizeSessionSettings, type SessionSettings } from "./settings"
import { createBuiltinRegistry, type ToolContext, type ToolRegistryLike, type ToolResult } from "./tool"

type CacheBenchmarkProfile = CacheStrategy
type BenchmarkProviderName = ProviderName | "simulated"

type CacheBenchmarkTask = {
  id: string
  mode: AgentMode
  fixture: string
  tools?: "builtin" | "none"
  providers?: BenchmarkProviderName[]
  settings?: Partial<SessionSettings>
  syntheticToolLoop?: "read-once"
  turns: string[]
}

type BenchmarkOptions = {
  root?: string
  provider?: BenchmarkProviderName
  profiles?: CacheBenchmarkProfile[]
  cachedInputMultiplier?: number
  outputTokenMultiplier?: number
  json?: boolean
}

type ProviderCallObservation = {
  profile: CacheBenchmarkProfile
  taskID: string
  turnIndex: number
  callIndex: number
  estimatedInputTokens: number
  estimatedCachedPrefixTokens: number
  actualInputTokens?: number
  actualOutputTokens?: number
  actualCacheHitTokens?: number
  actualCacheMissTokens?: number
}

type ProfileSummary = {
  profile: CacheBenchmarkProfile
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  hitRate: number
  effectiveInputTokens: number
  effectiveOutputTokens: number
  effectiveTotalTokens: number
}

const profileStrategies: Record<Exclude<CacheBenchmarkProfile, "auto">, StaticContextStrategy> = {
  balanced: "first-step",
  "cache-heavy": "every-step",
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

class CacheBenchmarkRecorder {
  private readonly cacheEntries: string[] = []
  private readonly observations: ProviderCallObservation[] = []
  private turnIndex = 0

  constructor(private readonly profile: CacheBenchmarkProfile, private readonly taskID: string) {}

  startTurn(turnIndex: number) {
    this.turnIndex = turnIndex
  }

  observe(input: ProviderInput) {
    const serialized = serializeProviderInput(input)
    const estimatedInputTokens = estimateProviderInputTokens(input)
    const estimatedCachedPrefixTokens = this.cacheEntries.reduce((best, entry) => Math.max(best, cacheableCommonPrefixTokens(entry, serialized)), 0)
    this.cacheEntries.push(serialized)
    const observation: ProviderCallObservation = {
      profile: this.profile,
      taskID: this.taskID,
      turnIndex: this.turnIndex,
      callIndex: this.observations.length + 1,
      estimatedInputTokens,
      estimatedCachedPrefixTokens,
    }
    this.observations.push(observation)
    return observation
  }

  recordUsage(observation: ProviderCallObservation, event: Extract<ProviderEvent, { type: "usage" }>) {
    observation.actualInputTokens = event.inputTokens
    observation.actualOutputTokens = event.outputTokens
    observation.actualCacheHitTokens = event.cacheHitTokens
    observation.actualCacheMissTokens = event.cacheMissTokens
  }

  snapshot() {
    return [...this.observations]
  }
}

class RecordingProvider implements Provider {
  readonly name: string
  readonly model?: string
  readonly capabilities: ProviderCapabilities

  constructor(
    private readonly recorder: CacheBenchmarkRecorder,
    private readonly options: {
      inner?: Provider
      syntheticToolLoop?: CacheBenchmarkTask["syntheticToolLoop"]
    },
  ) {
    this.name = options.inner?.name ?? "simulated"
    this.model = options.inner?.model
    this.capabilities = options.inner?.capabilities ?? defaultProviderCapabilities
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    const observation = this.recorder.observe(input)
    if (!this.options.inner) {
      yield* this.syntheticStream(input, observation)
      return
    }
    for await (const event of this.options.inner.stream(input)) {
      if (event.type === "usage") this.recorder.recordUsage(observation, event)
      yield event
    }
  }

  private async *syntheticStream(input: ProviderInput, observation: ProviderCallObservation): AsyncIterable<ProviderEvent> {
    const usage: Extract<ProviderEvent, { type: "usage" }> = {
      type: "usage",
      inputTokens: observation.estimatedInputTokens,
      outputTokens: this.options.syntheticToolLoop && !latestTurnHasToolResult(input.messages, "read") ? 4 : 12,
      cacheHitTokens: observation.estimatedCachedPrefixTokens,
      cacheMissTokens: Math.max(0, observation.estimatedInputTokens - observation.estimatedCachedPrefixTokens),
    }

    if (this.options.syntheticToolLoop === "read-once" && !latestTurnHasToolResult(input.messages, "read")) {
      yield { type: "tool_call", call: { id: `call_cache_read_${observation.callIndex}`, name: "read", input: { filePath: "src/add.ts" } } }
      this.recorder.recordUsage(observation, usage)
      yield usage
      yield { type: "done" }
      return
    }

    yield { type: "text_delta", text: "Cache benchmark response." }
    this.recorder.recordUsage(observation, usage)
    yield usage
    yield { type: "done" }
  }
}

export async function runCacheBenchmark(options: BenchmarkOptions = {}) {
  const projectRoot = options.root ?? path.resolve(import.meta.dir, "..")
  await loadEnvFile(projectRoot)
  const provider = options.provider ?? "simulated"
  const profiles = options.profiles ?? ["balanced", "cache-heavy", "auto"]
  const defaultPricing = defaultCachePricing()
  const cachedInputMultiplier = options.cachedInputMultiplier ?? defaultPricing.inputCacheHit / defaultPricing.inputCacheMiss
  const outputTokenMultiplier = options.outputTokenMultiplier ?? defaultPricing.output / defaultPricing.inputCacheMiss
  const tasks = await loadTasks(projectRoot, provider)
  const observations: ProviderCallObservation[] = []

  for (const profile of profiles) {
    for (const task of tasks) {
      const workdir = path.join(os.tmpdir(), `easycode-cache-${task.id}-${profile}-${Date.now()}`)
      await copyDir(path.join(projectRoot, task.fixture), workdir)
      const recorder = new CacheBenchmarkRecorder(profile, task.id)
      const inner = provider === "simulated" ? undefined : createProvider(provider)
      const wrappedProvider = new RecordingProvider(recorder, { inner, syntheticToolLoop: task.syntheticToolLoop })
      const settings = normalizeSessionSettings({ ...task.settings, provider, cacheStrategy: profile }, provider)
      const runner = new AgentRunner({
        root: workdir,
        provider: wrappedProvider,
        registry: task.tools === "none" ? emptyRegistry : createBuiltinRegistry(),
        context: new ContextManager(),
        permission: PermissionService.autoApprove(defaultPermissionRules(task.mode)),
        settings,
        staticContextStrategy: profile === "auto" ? undefined : profileStrategies[profile],
      })

      for (const [turnIndex, prompt] of task.turns.entries()) {
        recorder.startTurn(turnIndex)
        await runner.run(prompt, task.mode)
      }

      observations.push(...recorder.snapshot())
      await rm(workdir, { recursive: true, force: true })
    }
  }

  return {
    provider,
    cachedInputMultiplier,
    outputTokenMultiplier,
    summaries: profiles.map((profile) => summarizeProfile(profile, observations, cachedInputMultiplier, outputTokenMultiplier)),
    observations,
  }
}

function summarizeProfile(profile: CacheBenchmarkProfile, observations: ProviderCallObservation[], cachedInputMultiplier: number, outputTokenMultiplier: number): ProfileSummary {
  const calls = observations.filter((observation) => observation.profile === profile)
  let inputTokens = 0
  let outputTokens = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0
  for (const call of calls) {
    const input = call.actualInputTokens ?? call.estimatedInputTokens
    const hit = call.actualCacheHitTokens ?? Math.min(call.estimatedCachedPrefixTokens, input)
    inputTokens += input
    outputTokens += call.actualOutputTokens ?? 0
    cacheHitTokens += hit
    cacheMissTokens += call.actualCacheMissTokens ?? Math.max(0, input - hit)
  }
  const effectiveInputTokens = cacheMissTokens + cacheHitTokens * cachedInputMultiplier
  const effectiveOutputTokens = outputTokens * outputTokenMultiplier
  return {
    profile,
    calls: calls.length,
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheMissTokens,
    hitRate: inputTokens === 0 ? 0 : cacheHitTokens / inputTokens,
    effectiveInputTokens,
    effectiveOutputTokens,
    effectiveTotalTokens: effectiveInputTokens + effectiveOutputTokens,
  }
}

async function loadTasks(projectRoot: string, provider: BenchmarkProviderName) {
  const taskDir = path.join(projectRoot, "evals", "cache")
  const files = (await readdir(taskDir)).filter((file) => file.endsWith(".json")).sort((left, right) => left.localeCompare(right))
  const tasks: CacheBenchmarkTask[] = []
  for (const file of files) {
    const task = JSON.parse(await Bun.file(path.join(taskDir, file)).text()) as CacheBenchmarkTask
    if (task.providers && !task.providers.includes(provider)) continue
    if (provider !== "simulated" && task.syntheticToolLoop) continue
    tasks.push(task)
  }
  return tasks
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

function latestTurnHasToolResult(messages: Message[], toolName: string) {
  let latestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      latestUserIndex = index
      break
    }
  }
  return messages.slice(Math.max(0, latestUserIndex + 1)).some((message) => message.parts.some((part) => part.type === "tool_result" && part.toolName === toolName))
}

function estimateProviderInputTokens(input: ProviderInput) {
  return estimateTextTokens(serializeProviderInput(input))
}

function serializeProviderInput(input: ProviderInput) {
  const messages = input.providerMessages.map((message) => `${message.role}\n${message.content}`).join("\n---message---\n")
  const tools = input.tools.map((tool) => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.jsonSchema)}`).join("\n---tool---\n")
  return `mode:${input.mode}\nmessages:\n${messages}\ntools:\n${tools}`
}

function cacheableCommonPrefixTokens(left: string, right: string) {
  const tokens = estimateTextTokens(left.slice(0, commonPrefixLength(left, right)))
  return tokens >= 1024 ? tokens : 0
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const provider = valueAfter(argv, "--provider") ?? "simulated"
  if (provider !== "simulated" && !hasProvider(provider)) throw new Error(`Unknown provider: ${provider}. Available providers: simulated, ${listProviders().join(", ")}`)
  const profile = valueAfter(argv, "--profile")
  const profiles = profile && profile !== "both" ? [profile as CacheBenchmarkProfile] : undefined
  if (profiles?.some((item) => item !== "auto" && !(item in profileStrategies))) throw new Error(`Unknown profile: ${profile}. Use balanced, cache-heavy, auto, or both.`)
  const cachedMultiplier = valueAfter(argv, "--cached-input-multiplier")
  const outputMultiplier = valueAfter(argv, "--output-token-multiplier")
  return {
    provider,
    profiles,
    cachedInputMultiplier: cachedMultiplier === undefined ? undefined : Number(cachedMultiplier),
    outputTokenMultiplier: outputMultiplier === undefined ? undefined : Number(outputMultiplier),
    json: argv.includes("--json"),
  }
}

function valueAfter(argv: string[], flag: string) {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

function formatReport(report: Awaited<ReturnType<typeof runCacheBenchmark>>) {
  const lines = [
    `Cache benchmark provider=${report.provider} cached_input_multiplier=${report.cachedInputMultiplier} output_token_multiplier=${report.outputTokenMultiplier}`,
    `cost ratio: 1 cache-miss input token ~= ${(1 / report.cachedInputMultiplier).toFixed(1)} cached input tokens`,
    "profile       calls  input  cached  hit%   miss   output  effective_total",
  ]
  for (const summary of report.summaries) {
    lines.push(`${summary.profile.padEnd(13)} ${String(summary.calls).padStart(5)} ${String(Math.round(summary.inputTokens)).padStart(6)} ${String(Math.round(summary.cacheHitTokens)).padStart(7)} ${(summary.hitRate * 100).toFixed(1).padStart(5)} ${String(Math.round(summary.cacheMissTokens)).padStart(6)} ${String(Math.round(summary.outputTokens)).padStart(7)} ${String(Math.round(summary.effectiveTotalTokens)).padStart(16)}`)
  }
  const best = [...report.summaries].sort((left, right) => left.effectiveTotalTokens - right.effectiveTotalTokens)[0]
  if (best) lines.push(`recommendation: ${best.profile} minimizes effective token cost in this benchmark.`)
  return lines.join("\n")
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  const report = await runCacheBenchmark(options)
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report))
}
