import path from "node:path"
import { loadEnvFile } from "../../../src/cli"
import { ContextManager } from "../../../src/context"
import { createProvider } from "../../../src/provider"
import { textMessage } from "../../../src/message"
import { agentForCase, contextLedgerForCase, fixtureBlockForCase, loadFixture, maxOutputTokensForCase, messagesForCase, selectCases, trustForCase, unsupportedExpectedFieldsFor } from "./case"
import { cacheEvaluationForCase, emptyUsage, mergeUsage } from "./usage"
import { summarize } from "./report"
import { optimizationForCause, primaryCauseFor, validateCase } from "./validation"
import type { APIxCase, APIxManifest, APIxOptions, APIxProviderRun, APIxResult } from "./types"

export async function runAPIxEval(options: APIxOptions) {
  await loadEnvFile(options.root)
  const manifest = await Bun.file(path.join(options.root, "evals", "apix", "tasks.json")).json() as APIxManifest
  const tasks = selectCases(manifest.cases, options)
  const results: APIxResult[] = []

  for (const task of tasks) {
    const fixture = await loadFixture(options.root, task)
    const unsupportedExpectedFields = unsupportedExpectedFieldsFor(task)
    const ignoredExpectedFields = task.evaluation_mode === "hard_gate" ? [] : unsupportedExpectedFields
    const trust = trustForCase(task, unsupportedExpectedFields)
    if (fixture.required && fixture.content === undefined) {
      const failures = [`missing required fixture ${task.fixture}`]
      results.push({
        id: task.id,
        dimension: task.dimension,
        priority: task.priority,
        evaluationMode: task.evaluation_mode,
        goal: task.goal,
        passed: false,
        scoreOnly: task.evaluation_mode !== "hard_gate",
        failures,
        unsupportedExpectedFields,
        ignoredExpectedFields,
        trust: { level: "tainted", reasons: [...trust.reasons, "missing_required_fixture"] },
        primaryCause: "resource_failure",
        optimization: optimizationForCause("resource_failure"),
        output: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        latencyMs: 0,
      })
      if (!options.quiet) console.error(`[apix] skip ${task.id} missing_fixture=${task.fixture}`)
      continue
    }
    if (task.evaluation_mode === "hard_gate" && unsupportedExpectedFields.length > 0) {
      const failures = [`unsupported_validator ${unsupportedExpectedFields.join(",")}`]
      results.push({
        id: task.id,
        dimension: task.dimension,
        priority: task.priority,
        evaluationMode: task.evaluation_mode,
        goal: task.goal,
        passed: false,
        scoreOnly: false,
        failures,
        unsupportedExpectedFields,
        ignoredExpectedFields,
        trust,
        primaryCause: "unsupported_validator",
        optimization: optimizationForCause("unsupported_validator"),
        output: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        latencyMs: 0,
      })
      if (!options.quiet) console.error(`[apix] skip ${task.id} unsupported_validator=${unsupportedExpectedFields.join(",")}`)
      continue
    }
    const providerProbe = createProvider(options.provider, {
      ...(options.model ? { model: options.model } : {}),
    })
    const useNativeJsonMode = Boolean(task.expected.json_schema && providerProbe.capabilities?.supportsJsonObjectResponse)
    const provider = createProvider(options.provider, {
      ...(options.model ? { model: options.model } : {}),
      thinking: task.expected.json_schema ? false : options.thinking,
      ...(useNativeJsonMode ? { responseFormat: "json_object" as const } : {}),
      maxOutputTokens: maxOutputTokensForCase(task, options.maxOutputTokens),
    })
    const startedLabel = new Date().toISOString()
    if (!options.quiet) console.error(`[apix] start ${task.id} ${task.dimension} ${startedLabel}`)
    const context = new ContextManager()
    const agent = agentForCase(task)
    context.setLedger(contextLedgerForCase(task, fixture.content))
    if (fixture.content) context.add(textMessage("user", fixtureBlockForCase(task, fixture.content)))
    for (const message of messagesForCase(task)) context.add(message)
    const plan = context.planRequest({ step: 0, agent, skills: [], selectedSkills: [], tools: [] })
    const providerMessages = plan.providerMessages
    const cacheEvaluation = cacheEvaluationForCase(task, provider.capabilities?.promptCacheMinPrefixTokens, plan.cacheStats.currentStaticPrefixTokens)
    const warmup = cacheEvaluation.requiredRatio !== undefined && cacheEvaluation.eligible
      ? await runProviderForCase(task, context, provider, providerMessages)
      : undefined
    const measured = await runProviderForCase(task, context, provider, providerMessages)
    const usage = { ...measured.usage }
    let output = measured.output.trim()
    let failures = validateCase(task, output, measured.usage, cacheEvaluation)
    let repairAttempted = false
    let repairFailures: string[] | undefined
    let rawOutput: string | undefined
    if (shouldAttemptRepair(failures, measured.providerFailures)) {
      repairAttempted = true
      rawOutput = output
      const repair = await runRepairForCase(task, provider, output, failures)
      repairFailures = repair.providerFailures
      if (repair.providerFailures.length === 0) {
        const repairedOutput = repair.output.trim()
        const repairedFailures = validateCase(task, repairedOutput, measured.usage, cacheEvaluation)
        addUsage(usage, repair.usage)
        if (repairedFailures.length < failures.length) {
          output = repairedOutput
          failures = repairedFailures
        }
      }
    }
    if (warmup) failures.unshift(...warmup.providerFailures.map((failure) => `warmup provider failure: ${failure}`))
    failures.unshift(...measured.providerFailures.map((failure) => `provider failure: ${failure}`))
    const primaryCause = failures.length ? primaryCauseFor(task, failures, usage) : undefined
    results.push({
      id: task.id,
      dimension: task.dimension,
      priority: task.priority,
      evaluationMode: task.evaluation_mode,
      goal: task.goal,
      passed: failures.length === 0,
      scoreOnly: task.evaluation_mode !== "hard_gate",
      failures,
      unsupportedExpectedFields,
      ignoredExpectedFields,
      trust,
      primaryCause,
      optimization: primaryCause ? optimizationForCause(primaryCause) : undefined,
      ...(rawOutput !== undefined ? { rawOutput } : {}),
      ...(repairAttempted ? { repairAttempted } : {}),
      ...(repairFailures ? { repairFailures } : {}),
      output,
      usage,
      ...(warmup ? { warmupUsage: warmup.usage } : {}),
      measuredUsage: measured.usage,
      ...(cacheEvaluation.requiredRatio !== undefined ? { cacheEvaluation } : {}),
      latencyMs: measured.latencyMs,
      ttftMs: measured.ttftMs,
    })
    if (!options.quiet) {
      const latest = results.at(-1)
      console.error(`[apix] done ${task.id} pass=${latest?.passed ? "yes" : "no"} latency_ms=${latest?.latencyMs ?? "-"} input=${latest?.usage.inputTokens ?? 0} output=${latest?.usage.outputTokens ?? 0}`)
    }
  }

  return summarize(options, results)
}

async function runProviderForCase(
  task: APIxCase,
  context: ContextManager,
  provider: ReturnType<typeof createProvider>,
  providerMessages: ReturnType<ContextManager["planRequest"]>["providerMessages"],
): Promise<APIxProviderRun> {
  const startedAt = Date.now()
  let ttftMs: number | undefined
  let output = ""
  const providerFailures: string[] = []
  const usage = emptyUsage()
  const stream = provider.stream({
    mode: "build",
    prompt: task.turns.at(-1)?.content ?? task.goal,
    messages: context.state.messages,
    providerMessages,
    tools: [],
  })

  try {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt
        output += event.text
      }
      if (event.type === "usage") {
        mergeUsage(usage, event)
        context.observeUsage(event)
      }
      if (event.type === "failure") {
        const message = event.error.output || event.error.message
        providerFailures.push(message)
        output += message
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    providerFailures.push(message)
    output += message
  }

  return { output, usage, providerFailures, latencyMs: Date.now() - startedAt, ttftMs }
}

async function runRepairForCase(
  task: APIxCase,
  provider: ReturnType<typeof createProvider>,
  output: string,
  failures: string[],
) {
  const prompt = repairPromptForCase(task, output, failures)
  return runProviderForCase(task, new ContextManager(), provider, [{ role: "user", content: prompt }])
}

function repairPromptForCase(task: APIxCase, output: string, failures: string[]) {
  return [
    "Repair this APIx answer so it satisfies the deterministic validation constraints.",
    "Return only the repaired final answer. Do not explain the repair.",
    `Task goal: ${task.goal}`,
    `Validation failures: ${failures.join("; ")}`,
    `Expected constraints: ${JSON.stringify(task.expected)}`,
    "<candidate>",
    output,
    "</candidate>",
  ].join("\n")
}

function shouldAttemptRepair(failures: string[], providerFailures: string[]) {
  if (providerFailures.length > 0 || failures.length === 0) return false
  return failures.every((failure) => !failure.includes("cache hit ratio") && !failure.includes("cache not eligible"))
}

function addUsage(base: APIxProviderRun["usage"], extra: APIxProviderRun["usage"]) {
  base.inputTokens += extra.inputTokens
  base.outputTokens += extra.outputTokens
  base.cacheHitTokens += extra.cacheHitTokens
  base.cacheMissTokens += extra.cacheMissTokens
  base.totalTokens = (base.totalTokens ?? 0) + (extra.totalTokens ?? 0)
  base.reasoningTokens = (base.reasoningTokens ?? 0) + (extra.reasoningTokens ?? 0)
}
