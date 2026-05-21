import path from "node:path"
import os from "node:os"
import { mkdir, readdir, rm } from "node:fs/promises"
import { AgentRunner } from "./agent"
import { defaultCachePricing } from "./cache-policy"
import { ContextManager, estimateTextTokens, type ContextStrategyState } from "./context"
import { loadEnvFile } from "./cli"
import type { AgentMode, Message } from "./message"
import { defaultPermissionRules, PermissionService } from "./permission"
import { createProvider, defaultProviderCapabilities, hasProvider, listProviders, type Provider, type ProviderCapabilities, type ProviderEvent, type ProviderInput, type ProviderName } from "./provider"
import { normalizeSessionSettings, type SessionSettings } from "./settings"
import { createBuiltinRegistry, type ToolContext, type ToolRegistryLike, type ToolResult } from "./tool"

type CacheBenchmarkProfile = "every-step"
type BenchmarkProviderName = ProviderName | "simulated"
type BenchmarkSuite = "real" | "all"

type CacheBenchmarkTask = {
  id: string
  mode: AgentMode
  fixture: string
  tools?: "builtin" | "none"
  providers?: BenchmarkProviderName[]
  profiles?: CacheBenchmarkProfile[]
  suite?: BenchmarkSuite
  settings?: Partial<SessionSettings>
  syntheticToolLoop?: "read-once" | "read-always" | "semantic-once"
  syntheticUsagePattern?: Array<{ inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number }>
  turns: string[]
}

type BenchmarkOptions = {
  root?: string
  provider?: BenchmarkProviderName
  profiles?: CacheBenchmarkProfile[]
  cachedInputMultiplier?: number
  outputTokenMultiplier?: number
  suite?: BenchmarkSuite
  json?: boolean
  quiet?: boolean
  heartbeatMs?: number
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
  finalStrategyState?: ContextStrategyState
}

type BenchmarkLogger = (message: string) => void

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
      syntheticUsagePattern?: CacheBenchmarkTask["syntheticUsagePattern"]
      logger?: BenchmarkLogger
      heartbeatMs?: number
    },
  ) {
    this.name = options.inner?.name ?? "simulated"
    this.model = options.inner?.model
    this.capabilities = options.inner?.capabilities ?? defaultProviderCapabilities
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    const observation = this.recorder.observe(input)
    this.log(`call start profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} est_input=${observation.estimatedInputTokens} est_cached_prefix=${observation.estimatedCachedPrefixTokens} provider=${this.name}`)
    if (!this.options.inner) {
      yield* this.syntheticStream(input, observation)
      this.log(`call done profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex}`)
      return
    }
    let lastEventAt = Date.now()
    const heartbeat = setInterval(() => {
      const idleSeconds = Math.round((Date.now() - lastEventAt) / 1000)
      this.log(`waiting profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} idle=${idleSeconds}s provider=${this.name}`)
    }, this.options.heartbeatMs ?? 10_000)
    try {
      for await (const event of this.options.inner.stream(input)) {
        lastEventAt = Date.now()
        if (event.type === "usage") {
          const usage = this.patternedUsage(observation) ?? event
          this.recorder.recordUsage(observation, usage)
          this.log(`usage profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} input=${usage.inputTokens} cached=${usage.cacheHitTokens ?? 0} miss=${usage.cacheMissTokens ?? Math.max(0, usage.inputTokens - (usage.cacheHitTokens ?? 0))} output=${usage.outputTokens}${this.options.syntheticUsagePattern ? " source=pattern" : ""}`)
          yield usage
          continue
        }
        if (event.type === "request") this.log(`request profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} url=${event.request.url}`)
        if (event.type === "response") this.log(`response profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} status=${event.response.status} ok=${event.response.ok}`)
        if (event.type === "tool_call") this.log(`tool_call profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} tool=${event.call.name}`)
        if (event.type === "failure") this.log(`failure profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} code=${event.error.code ?? "-"} message=${oneLine(event.error.message)}`)
        if (event.type === "done") this.log(`call done profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex}`)
        yield event
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  private async *syntheticStream(input: ProviderInput, observation: ProviderCallObservation): AsyncIterable<ProviderEvent> {
    const usage: Extract<ProviderEvent, { type: "usage" }> = {
      type: "usage",
      inputTokens: observation.estimatedInputTokens,
      outputTokens: this.shouldRead(input) ? 4 : 12,
      cacheHitTokens: observation.estimatedCachedPrefixTokens,
      cacheMissTokens: Math.max(0, observation.estimatedInputTokens - observation.estimatedCachedPrefixTokens),
    }
    const patterned = this.patternedUsage(observation) ?? usage

    if (this.shouldRepoMap(input)) {
      yield { type: "tool_call", call: { id: `call_cache_repo_map_${observation.callIndex}`, name: "repo_map", input: { dir: "src", language: "typescript" } } }
      this.recorder.recordUsage(observation, patterned)
      this.log(`usage profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} input=${patterned.inputTokens} cached=${patterned.cacheHitTokens ?? 0} miss=${patterned.cacheMissTokens ?? Math.max(0, patterned.inputTokens - (patterned.cacheHitTokens ?? 0))} output=${patterned.outputTokens}${this.options.syntheticUsagePattern ? " source=pattern" : ""}`)
      yield patterned
      yield { type: "done" }
      return
    }

    if (this.shouldReadLines(input)) {
      yield { type: "tool_call", call: { id: `call_cache_read_lines_${observation.callIndex}`, name: "read_lines", input: { filePath: "src/add.ts", startLine: 1, endLine: 3 } } }
      this.recorder.recordUsage(observation, patterned)
      this.log(`usage profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} input=${patterned.inputTokens} cached=${patterned.cacheHitTokens ?? 0} miss=${patterned.cacheMissTokens ?? Math.max(0, patterned.inputTokens - (patterned.cacheHitTokens ?? 0))} output=${patterned.outputTokens}${this.options.syntheticUsagePattern ? " source=pattern" : ""}`)
      yield patterned
      yield { type: "done" }
      return
    }

    if (this.shouldRead(input)) {
      yield { type: "tool_call", call: { id: `call_cache_read_${observation.callIndex}`, name: "read", input: { filePath: "src/add.ts" } } }
      this.recorder.recordUsage(observation, patterned)
      this.log(`usage profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} input=${patterned.inputTokens} cached=${patterned.cacheHitTokens ?? 0} miss=${patterned.cacheMissTokens ?? Math.max(0, patterned.inputTokens - (patterned.cacheHitTokens ?? 0))} output=${patterned.outputTokens}${this.options.syntheticUsagePattern ? " source=pattern" : ""}`)
      yield patterned
      yield { type: "done" }
      return
    }

    yield { type: "text_delta", text: "Cache benchmark response." }
    this.recorder.recordUsage(observation, patterned)
    this.log(`usage profile=${observation.profile} task=${observation.taskID} turn=${observation.turnIndex + 1} call=${observation.callIndex} input=${patterned.inputTokens} cached=${patterned.cacheHitTokens ?? 0} miss=${patterned.cacheMissTokens ?? Math.max(0, patterned.inputTokens - (patterned.cacheHitTokens ?? 0))} output=${patterned.outputTokens}${this.options.syntheticUsagePattern ? " source=pattern" : ""}`)
    yield patterned
    yield { type: "done" }
  }

  private shouldRead(input: ProviderInput) {
    if (this.options.syntheticToolLoop === "read-always") return true
    return this.options.syntheticToolLoop === "read-once" && !latestTurnHasToolResult(input.messages, "read")
  }

  private shouldRepoMap(input: ProviderInput) {
    return this.options.syntheticToolLoop === "semantic-once" && !latestTurnHasToolResult(input.messages, "repo_map")
  }

  private shouldReadLines(input: ProviderInput) {
    return this.options.syntheticToolLoop === "semantic-once" && latestTurnHasToolResult(input.messages, "repo_map") && !latestTurnHasToolResult(input.messages, "read_lines")
  }

  private patternedUsage(observation: ProviderCallObservation): Extract<ProviderEvent, { type: "usage" }> | undefined {
    const pattern = this.options.syntheticUsagePattern
    if (!pattern || pattern.length === 0) return undefined
    const item = pattern[Math.min(observation.callIndex - 1, pattern.length - 1)]
    const hit = item.cacheHitTokens ?? 0
    return {
      type: "usage",
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheHitTokens: item.cacheHitTokens,
      cacheMissTokens: item.cacheMissTokens ?? (item.cacheHitTokens === undefined ? undefined : Math.max(0, item.inputTokens - hit)),
    }
  }

  private log(message: string) {
    this.options.logger?.(message)
  }
}

export async function runCacheBenchmark(options: BenchmarkOptions = {}) {
  const projectRoot = options.root ?? path.resolve(import.meta.dir, "..")
  await loadEnvFile(projectRoot)
  const provider = options.provider ?? "deepseek"
  const suite = options.suite ?? "real"
  const profiles = options.profiles ?? ["every-step" as const]
  const defaultPricing = defaultCachePricing()
  const cachedInputMultiplier = options.cachedInputMultiplier ?? defaultPricing.inputCacheHit / defaultPricing.inputCacheMiss
  const outputTokenMultiplier = options.outputTokenMultiplier ?? 0
  const tasks = await loadTasks(projectRoot, provider, suite)
  const observations: ProviderCallObservation[] = []
  const finalStrategyStates = new Map<CacheBenchmarkProfile, ContextStrategyState>()
  const logger = options.quiet === false ? benchmarkLogger() : undefined
  logger?.(`start provider=${provider} suite=${suite} profiles=${profiles.join(",")} tasks=${tasks.map((task) => task.id).join(",")} heartbeat_ms=${options.heartbeatMs ?? 10_000}`)

  for (const profile of profiles) {
    logger?.(`profile start profile=${profile}`)
    for (const task of tasks) {
      if (task.profiles && !task.profiles.includes(profile)) continue
      logger?.(`task start profile=${profile} task=${task.id} turns=${task.turns.length} tools=${task.tools ?? "builtin"} synthetic_usage=${task.syntheticUsagePattern ? "yes" : "no"}`)
      const workdir = path.join(os.tmpdir(), `easycode-cache-${task.id}-${profile}-${Date.now()}`)
      await copyDir(path.join(projectRoot, task.fixture), workdir)
      const recorder = new CacheBenchmarkRecorder(profile, task.id)
      const inner = provider === "simulated" ? undefined : createProvider(provider)
      const wrappedProvider = new RecordingProvider(recorder, { inner, syntheticToolLoop: task.syntheticToolLoop, syntheticUsagePattern: task.syntheticUsagePattern, logger, heartbeatMs: options.heartbeatMs })
      const settings = normalizeSessionSettings({ ...task.settings, provider }, provider)
      const context = new ContextManager()
      const runner = new AgentRunner({
        root: workdir,
        provider: wrappedProvider,
        registry: task.tools === "none" ? emptyRegistry : createBuiltinRegistry(),
        context,
        permission: PermissionService.autoApprove(defaultPermissionRules(task.mode)),
        settings,
      })

      for (const [turnIndex, prompt] of task.turns.entries()) {
        logger?.(`turn start profile=${profile} task=${task.id} turn=${turnIndex + 1}/${task.turns.length} prompt=${oneLine(prompt)}`)
        recorder.startTurn(turnIndex)
        await runner.run(prompt, task.mode)
        logger?.(`turn done profile=${profile} task=${task.id} turn=${turnIndex + 1}/${task.turns.length} strategy=${strategyLabel(context.strategyState)}`)
      }

      observations.push(...recorder.snapshot())
      finalStrategyStates.set(profile, context.strategyState)
      await rm(workdir, { recursive: true, force: true })
      logger?.(`task done profile=${profile} task=${task.id} calls=${recorder.snapshot().length} strategy=${strategyLabel(context.strategyState)}`)
    }
    logger?.(`profile done profile=${profile}`)
  }

  return {
    provider,
    suite,
    cachedInputMultiplier,
    outputTokenMultiplier,
    summaries: profiles.map((profile) => summarizeProfile(profile, observations, cachedInputMultiplier, outputTokenMultiplier, finalStrategyStates.get(profile))),
    observations,
  }
}

function summarizeProfile(profile: CacheBenchmarkProfile, observations: ProviderCallObservation[], cachedInputMultiplier: number, outputTokenMultiplier: number, finalStrategyState: ContextStrategyState | undefined): ProfileSummary {
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
    finalStrategyState,
  }
}

async function loadTasks(projectRoot: string, provider: BenchmarkProviderName, suite: BenchmarkSuite) {
  const taskDir = path.join(projectRoot, "evals", "cache")
  const files = (await readdir(taskDir)).filter((file) => file.endsWith(".json")).sort((left, right) => left.localeCompare(right))
  const tasks: CacheBenchmarkTask[] = []
  for (const file of files) {
    const task = JSON.parse(await Bun.file(path.join(taskDir, file)).text()) as CacheBenchmarkTask
    if (task.providers && !task.providers.includes(provider)) continue
    const taskSuite = task.suite ?? "real"
    if (suite !== "all" && taskSuite !== suite) continue
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
  const provider = valueAfter(argv, "--provider") ?? "deepseek"
  if (provider !== "simulated" && !hasProvider(provider)) throw new Error(`Unknown provider: ${provider}. Available providers: simulated, ${listProviders().join(", ")}`)
  const profile = valueAfter(argv, "--profile")
  const profiles = profile ? [profile as CacheBenchmarkProfile] : undefined
  if (profiles?.some((item) => item !== "every-step")) throw new Error("Unknown profile. Use every-step.")
  const suite = (valueAfter(argv, "--suite") ?? "real") as BenchmarkSuite
  if (!["real", "all"].includes(suite)) throw new Error("Unknown suite. Use real or all.")
  const cachedMultiplier = valueAfter(argv, "--cached-input-multiplier")
  const outputMultiplier = valueAfter(argv, "--output-token-multiplier")
  const heartbeatMs = valueAfter(argv, "--heartbeat-ms")
  return {
    provider,
    profiles,
    suite,
    cachedInputMultiplier: cachedMultiplier === undefined ? undefined : Number(cachedMultiplier),
    outputTokenMultiplier: outputMultiplier === undefined ? undefined : Number(outputMultiplier),
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet"),
    heartbeatMs: heartbeatMs === undefined ? undefined : Number(heartbeatMs),
  }
}

function valueAfter(argv: string[], flag: string) {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

function formatReport(report: Awaited<ReturnType<typeof runCacheBenchmark>>) {
  const lines = [
    `Cache benchmark provider=${report.provider} suite=${report.suite} cached_input_multiplier=${report.cachedInputMultiplier} output_token_multiplier=${report.outputTokenMultiplier}`,
    `cost ratio: 1 cache-miss input token ~= ${(1 / report.cachedInputMultiplier).toFixed(1)} cached input tokens`,
    "profile       calls  input  cached  hit%   miss   output  effective_input  final",
  ]
  for (const summary of report.summaries) {
    lines.push(`${summary.profile.padEnd(13)} ${String(summary.calls).padStart(5)} ${String(Math.round(summary.inputTokens)).padStart(6)} ${String(Math.round(summary.cacheHitTokens)).padStart(7)} ${(summary.hitRate * 100).toFixed(1).padStart(5)} ${String(Math.round(summary.cacheMissTokens)).padStart(6)} ${String(Math.round(summary.outputTokens)).padStart(7)} ${String(Math.round(summary.effectiveTotalTokens)).padStart(16)} ${strategyLabel(summary.finalStrategyState)}`)
  }
  const best = [...report.summaries].sort((left, right) => left.effectiveTotalTokens - right.effectiveTotalTokens)[0]
  if (best) lines.push(`recommendation: ${best.profile} minimizes effective token cost in this benchmark.`)
  return lines.join("\n")
}

function strategyLabel(strategy: ContextStrategyState | undefined) {
  if (!strategy) return "-"
  return `${strategy.staticContextStrategy},maxTok=${strategy.maxTokens},tool=${strategy.toolResultTokenBudget},steps=${strategy.maxSteps}`
}

function benchmarkLogger(): BenchmarkLogger {
  const startedAt = Date.now()
  return (message) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)
    console.error(`[cache-bench +${elapsed}s] ${message}`)
  }
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 120)
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  const report = await runCacheBenchmark(options)
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report))
}
