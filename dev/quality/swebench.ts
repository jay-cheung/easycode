#!/usr/bin/env bun
import os from "node:os"
import path from "node:path"
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createRunner, hasProposedPlanText, type AgentRunResult } from "../../src/agent"
import { loadEnvFile } from "../../src/cli/startup"
import { createLogger } from "../../src/logger"
import { defaultPermissionRules, PermissionService } from "../../src/permission"
import { hasProvider, listProviders, type ProviderName } from "../../src/provider"
import { normalizeSessionSettings } from "../../src/settings"
import { exportDataset, type SWEBenchDatasetPreset } from "./swebench-dataset"

export type SWEBenchInstance = {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  hints_text?: string | null
}

export type SWEBenchPrediction = {
  instance_id: string
  model_name_or_path: string
  model_patch: string | null
}

export type SWEBenchCliOptions = {
  datasetPath?: string
  outputPath: string
  workspaceDir: string
  provider: ProviderName
  preset: SWEBenchDatasetPreset
  model?: string
  maxTokens?: number
  maxSteps?: number
  maxPlanRounds: number
  limit?: number
  instanceIDs?: string[]
  includeHints: boolean
  keepWorkdirs: boolean
  resume: boolean
  logger: boolean
  insecure: boolean
}

type SWEBenchInstanceResult = {
  instance: SWEBenchInstance
  prediction: SWEBenchPrediction
  status: "passed" | "failed"
  reason?: string
  planRounds: number
}

const defaultWorkspaceDir = ".easycode/swebench"
const defaultProvider = "deepseek"
const defaultPreset: SWEBenchDatasetPreset = "lite"
const defaultPresetLimit = 3
const approvedPlanPrompt = "Proceed with the approved plan."

export function parseArgs(argv: string[]): SWEBenchCliOptions {
  const insecure = argv.includes("--insecure") || argv.includes("-k")
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

  const preset = parsePreset(optionalStringFlag(argv, "--preset") ?? defaultPreset)
  const provider = optionalProviderFlag(argv, "--provider") ?? providerFromEnv() ?? defaultProvider
  if (!hasProvider(provider)) throw new Error(`Unknown provider: ${provider}. Available providers: ${listProviders().join(", ")}`)
  const datasetPath = optionalPathFlag(argv, "--dataset")
  const outputPath = optionalPathFlag(argv, "--output") ?? defaultOutputPath(provider, preset, datasetPath)
  const workspaceDir = optionalPathFlag(argv, "--workspace") ?? defaultWorkspaceDir
  const model = optionalStringFlag(argv, "--model")
  const maxTokens = optionalPositiveNumberFlag(argv, "--max-tokens")
  const maxSteps = optionalPositiveNumberFlag(argv, "--max-steps")
  const maxPlanRounds = optionalPositiveNumberFlag(argv, "--max-plan-rounds") ?? 4
  const limit = optionalPositiveNumberFlag(argv, "--limit") ?? (datasetPath ? undefined : defaultPresetLimit)
  const instanceIDs = optionalStringFlag(argv, "--instance-ids")?.split(",").map((value) => value.trim()).filter(Boolean)
  const includeHints = !argv.includes("--no-hints")
  const keepWorkdirs = argv.includes("--keep-workdirs")
  const resume = argv.includes("--resume")
  const logger = argv.includes("--logger")

  return {
    datasetPath: datasetPath ? path.resolve(datasetPath) : undefined,
    outputPath: path.resolve(outputPath),
    workspaceDir: path.resolve(workspaceDir),
    provider,
    preset,
    model,
    maxTokens,
    maxSteps,
    maxPlanRounds,
    limit,
    instanceIDs,
    includeHints,
    keepWorkdirs,
    resume,
    logger,
    insecure,
  }
}

function providerFromEnv() {
  const provider = process.env.EASYCODE_PROVIDER
  return provider && hasProvider(provider) ? provider : undefined
}

function optionalPathFlag(argv: string[], name: string) {
  return optionalStringFlag(argv, name)
}

function optionalProviderFlag(argv: string[], name: string) {
  return optionalStringFlag(argv, name)
}

function optionalStringFlag(argv: string[], name: string) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function optionalPositiveNumberFlag(argv: string[], name: string) {
  const raw = optionalStringFlag(argv, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`)
  return Math.round(value)
}

function parsePreset(value: string): SWEBenchDatasetPreset {
  if (value === "lite" || value === "verified") return value
  throw new Error("--preset must be lite or verified")
}

function defaultOutputPath(provider: string, preset: SWEBenchDatasetPreset, datasetPath: string | undefined) {
  const label = datasetPath ? path.basename(datasetPath, path.extname(datasetPath)) : `${preset}-smoke`
  return path.join(process.cwd(), `swebench-${label}-${provider}-predictions.jsonl`)
}

export async function loadSWEBenchInstances(datasetPath: string, options: { instanceIDs?: string[]; limit?: number } = {}) {
  const text = await readFile(datasetPath, "utf8")
  const rows = datasetPath.endsWith(".jsonl")
    ? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
    : extractRows(JSON.parse(text))
  const ids = options.instanceIDs ? new Set(options.instanceIDs) : undefined
  const instances = rows
    .map((row) => normalizeInstance(row))
    .filter((row) => (ids ? ids.has(row.instance_id) : true))
  return options.limit ? instances.slice(0, options.limit) : instances
}

function extractRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") throw new Error("dataset must be a JSON array/object or JSONL file")
  const record = value as Record<string, unknown>
  for (const key of ["instances", "rows", "data", "test", "validation", "train"]) {
    if (Array.isArray(record[key])) return record[key]
  }
  throw new Error("dataset JSON must contain an array at the top level or under instances/rows/data/test/validation/train")
}

function normalizeInstance(value: unknown): SWEBenchInstance {
  if (!value || typeof value !== "object") throw new Error("invalid SWE-bench row: expected object")
  const row = value as Record<string, unknown>
  const instance_id = requiredStringField(row, "instance_id")
  const repo = requiredStringField(row, "repo")
  const base_commit = requiredStringField(row, "base_commit")
  const problem_statement = requiredStringField(row, "problem_statement")
  const hints_text = typeof row.hints_text === "string" ? row.hints_text : row.hints_text == null ? null : String(row.hints_text)
  return { instance_id, repo, base_commit, problem_statement, hints_text }
}

function requiredStringField(row: Record<string, unknown>, key: string) {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`dataset row missing ${key}`)
  return value
}

export function buildSWEBenchPrompt(instance: SWEBenchInstance, options: { includeHints?: boolean } = {}) {
  const sections = [
    "You are solving a SWE-bench task inside the target repository.",
    "Read the code, implement the requested fix, and leave the working tree with the smallest correct patch.",
    "Do not stop at analysis. If you produce a proposed plan first, execution will be approved automatically after that step.",
    "Run focused validation when it materially reduces risk, but avoid unrelated cleanup.",
    "",
    `SWE-bench instance: ${instance.instance_id}`,
    `Repository: ${instance.repo}`,
    `Base commit: ${instance.base_commit}`,
    "",
    "GitHub issue:",
    instance.problem_statement.trim(),
  ]
  if (options.includeHints !== false && instance.hints_text?.trim()) {
    sections.push("", "Hints:", instance.hints_text.trim())
  }
  return `${sections.join("\n")}\n`
}

export async function captureGitDiff(repoDir: string) {
  const { stdout } = await runCommand(["git", "-C", repoDir, "diff", "--binary", "--no-ext-diff"], process.cwd())
  return stdout
}

export async function runSWEBenchPredictions(options: SWEBenchCliOptions) {
  const easycodeRoot = path.resolve(import.meta.dir, "../..")
  await loadEnvFile(easycodeRoot)
  await mkdir(options.workspaceDir, { recursive: true })
  await mkdir(path.dirname(options.outputPath), { recursive: true })

  const preparedDataset = await prepareDataset(options)
  const completed = options.resume ? await readCompletedPredictionIDs(options.outputPath) : new Set<string>()
  const instances = await loadSWEBenchInstances(preparedDataset.datasetPath, {
    instanceIDs: options.instanceIDs,
    limit: options.limit,
  })
  const pending = instances.filter((instance) => !completed.has(instance.instance_id))

  console.log(`Loaded ${instances.length} instances; running ${pending.length} pending with provider=${options.provider}.`)
  if (preparedDataset.temporary) {
    console.log(`Dataset fetched to a temporary file: ${preparedDataset.datasetPath}`)
  } else {
    console.log(`Dataset source: ${preparedDataset.datasetPath}`)
  }
  console.log(`Predictions output: ${options.outputPath}`)
  console.log("Note: unattended runs auto-approve build-mode permission prompts once and auto-approve proposed plans.")

  const results: SWEBenchInstanceResult[] = []
  try {
    for (const [index, instance] of pending.entries()) {
      console.log(`[${index + 1}/${pending.length}] ${instance.instance_id} (${instance.repo}@${instance.base_commit.slice(0, 12)})`)
      const result = await runSingleInstance(instance, options)
      results.push(result)
      await appendPrediction(options.outputPath, result.prediction)
      const status = result.status === "passed" ? "PASS" : "FAIL"
      const suffix = result.reason ? ` - ${result.reason}` : ""
      console.log(`${status} ${instance.instance_id} plan_rounds=${result.planRounds} patch=${result.prediction.model_patch ? "yes" : "no"}${suffix}`)
    }
  } finally {
    if (preparedDataset.cleanupPath) {
      await rm(preparedDataset.cleanupPath, { recursive: true, force: true })
    }
  }

  console.log("")
  console.log(formatPredictionSummaryTable(results))

  return {
    total: pending.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  }
}

async function prepareDataset(options: SWEBenchCliOptions) {
  if (options.datasetPath) {
    return { datasetPath: options.datasetPath, temporary: false, cleanupPath: undefined as string | undefined }
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "easycode-swebench-dataset-"))
  const datasetPath = path.join(tempRoot, `${options.preset}-smoke.jsonl`)
  await exportDataset({
    preset: options.preset,
    outputPath: datasetPath,
    limit: options.limit ?? defaultPresetLimit,
    offset: 0,
    instanceIDs: options.instanceIDs,
  })
  return { datasetPath, temporary: true, cleanupPath: tempRoot }
}

export function formatPredictionSummaryTable(results: SWEBenchInstanceResult[]) {
  if (results.length === 0) return "No prediction rows were produced."
  const columns = [
    { key: "instance", title: "Instance" },
    { key: "status", title: "Status" },
    { key: "patch", title: "Patch" },
    { key: "plans", title: "Plans" },
    { key: "reason", title: "Reason" },
  ] as const
  const rows = results.map((result) => ({
    instance: result.instance.instance_id,
    status: result.status === "passed" ? "PASS" : "FAIL",
    patch: result.prediction.model_patch ? "yes" : "no",
    plans: String(result.planRounds),
    reason: result.reason ?? "",
  }))
  const widths = columns.map((column) => Math.max(
    column.title.length,
    ...rows.map((row) => truncateCell(row[column.key]).length),
  ))
  const separator = `+-${widths.map((width) => "-".repeat(width)).join("-+-")}-+`
  const renderRow = (values: string[]) => `| ${values.map((value, index) => truncateCell(value).padEnd(widths[index], " ")).join(" | ")} |`
  return [
    separator,
    renderRow(columns.map((column) => column.title)),
    separator,
    ...rows.map((row) => renderRow(columns.map((column) => row[column.key]))),
    separator,
  ].join("\n")
}

function truncateCell(value: string, max = 72) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

async function runSingleInstance(instance: SWEBenchInstance, options: SWEBenchCliOptions): Promise<SWEBenchInstanceResult> {
  const worktree = await prepareInstanceWorktree(instance, options.workspaceDir)
  let prediction: SWEBenchPrediction = {
    instance_id: instance.instance_id,
    model_name_or_path: modelLabel(options.provider, options.model),
    model_patch: null,
  }

  try {
    const runner = createRunner({
      root: worktree,
      provider: options.provider,
      mode: "build",
      logger: options.logger ? createLogger({ root: options.workspaceDir, session: `swebench-${instance.instance_id}` }) : undefined,
      permission: PermissionService.autoApprove(defaultPermissionRules("build")),
      settings: normalizeSessionSettings({
        provider: options.provider,
        model: options.model,
        maxTokens: options.maxTokens,
        maxSteps: options.maxSteps,
      }, options.provider),
      sessionId: `swebench-${instance.instance_id}`,
      forcePlanning: true,
    })

    let prompt = buildSWEBenchPrompt(instance, { includeHints: options.includeHints })
    let lastResult: AgentRunResult | undefined
    let planRounds = 0

    while (true) {
      lastResult = await runner.run(prompt, "build")
      if (lastResult.status !== "completed") {
        prediction = {
          ...prediction,
          model_patch: null,
        }
        return {
          instance,
          prediction,
          status: "failed",
          reason: summarizeRunFailure(lastResult),
          planRounds,
        }
      }
      if (!hasProposedPlanText(lastResult.text)) break
      planRounds += 1
      if (planRounds > options.maxPlanRounds) {
        return {
          instance,
          prediction,
          status: "failed",
          reason: `exceeded max plan rounds (${options.maxPlanRounds})`,
          planRounds,
        }
      }
      prompt = approvedPlanPrompt
    }

    const patch = await captureGitDiff(worktree)
    prediction = {
      ...prediction,
      model_patch: patch.trim() ? patch : null,
    }
    return {
      instance,
      prediction,
      status: "passed",
      planRounds,
    }
  } catch (error) {
    return {
      instance,
      prediction,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      planRounds: 0,
    }
  } finally {
    if (!options.keepWorkdirs) {
      await rm(worktree, { recursive: true, force: true })
    }
  }
}

function summarizeRunFailure(result: AgentRunResult) {
  const text = firstMeaningfulLine(result.text) ?? result.failureReason ?? result.status
  return `run ${result.status}: ${text}`
}

function firstMeaningfulLine(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
}

function modelLabel(provider: string, model: string | undefined) {
  return model ? `easycode/${provider}/${model}` : `easycode/${provider}`
}

async function prepareInstanceWorktree(instance: SWEBenchInstance, workspaceDir: string) {
  const repoCacheDir = path.join(workspaceDir, "repo-cache")
  const worktreeRoot = path.join(workspaceDir, "instances")
  await mkdir(repoCacheDir, { recursive: true })
  await mkdir(worktreeRoot, { recursive: true })

  const mirrorDir = path.join(repoCacheDir, safeSegment(instance.repo))
  const worktree = path.join(worktreeRoot, safeSegment(instance.instance_id))
  await ensureMirror(instance.repo, mirrorDir)
  await rm(worktree, { recursive: true, force: true })
  await runCommand(["git", "clone", "--shared", "--quiet", mirrorDir, worktree], workspaceDir)
  await runCommand(["git", "-C", worktree, "checkout", "--quiet", instance.base_commit], workspaceDir)
  return worktree
}

async function ensureMirror(repo: string, mirrorDir: string) {
  if (!(await pathExists(mirrorDir))) {
    await runCommand(["git", "clone", "--mirror", `https://github.com/${repo}.git`, mirrorDir], process.cwd())
    return
  }
  await runCommand(["git", "-C", mirrorDir, "fetch", "--all", "--prune"], process.cwd())
}

async function appendPrediction(outputPath: string, prediction: SWEBenchPrediction) {
  await appendFile(outputPath, `${JSON.stringify(prediction)}\n`, "utf8")
}

async function readCompletedPredictionIDs(outputPath: string) {
  if (!(await pathExists(outputPath))) return new Set<string>()
  const text = await readFile(outputPath, "utf8")
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Partial<SWEBenchPrediction>)
      .flatMap((row) => (typeof row.instance_id === "string" ? [row.instance_id] : [])),
  )
}

async function pathExists(target: string) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

async function runCommand(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`command failed (${cmd.join(" ")}): ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`)
  }
  return { stdout, stderr }
}

export function usage() {
  return [
    "Usage: bun run swebench:predictions --provider <name> [options]",
    "",
    "Options:",
    "  --preset <lite|verified>   Remote smoke dataset preset when --dataset is omitted (default: lite)",
    "  --dataset <path>           Optional local JSON/JSONL dataset; omit to fetch a temporary smoke set",
    "  --output <path>            Predictions JSONL path (default: current directory)",
    "  --workspace <dir>         Workspace for repo mirrors and instance worktrees (default: .easycode/swebench)",
    `  --provider <name>         Provider to run (${listProviders().join(", ")}). Default: EASYCODE_PROVIDER or ${defaultProvider}`,
    "  --model <id>              Optional model override",
    "  --max-tokens <n>          Session max tokens override",
    "  --max-steps <n>           Session max steps override",
    "  --max-plan-rounds <n>     Stop after this many auto-approved plan handoffs (default: 4)",
    "  --instance-ids <a,b>      Run only a comma-separated subset of instance ids",
    `  --limit <n>               Number of tasks to run (default: ${defaultPresetLimit} for remote smoke presets)`,
    "  --resume                  Skip instances already present in the output JSONL",
    "  --keep-workdirs           Keep per-instance worktrees after completion",
    "  --no-hints                Omit hints_text from the task prompt",
    "  --logger                  Persist EasyCode logs for each instance under the workspace root",
    "  --insecure, -k            Disable TLS verification for provider calls",
  ].join("\n")
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2)
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(usage())
      process.exit(0)
    }
    const report = await runSWEBenchPredictions(parseArgs(argv))
    console.log(`Finished: passed=${report.passed} failed=${report.failed} total=${report.total}`)
    if (report.failed > 0) process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error("")
    console.error(usage())
    process.exit(1)
  }
}
