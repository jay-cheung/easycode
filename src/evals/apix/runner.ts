import path from "node:path"
import { loadEnvFile } from "../../cli"
import { ContextManager } from "../../context"
import { createProvider } from "../../provider"
import { textMessage } from "../../message"
import { agentForCase, contextLedgerForCase, fixtureBlockForCase, loadFixture, maxOutputTokensForCase, messagesForCase, selectCases, unsupportedExpectedFieldsFor } from "./case"
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
        primaryCause: "unsupported_validator",
        optimization: optimizationForCause("unsupported_validator"),
        output: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        latencyMs: 0,
      })
      if (!options.quiet) console.error(`[apix] skip ${task.id} unsupported_validator=${unsupportedExpectedFields.join(",")}`)
      continue
    }
    const provider = createProvider(options.provider, {
      ...(options.model ? { model: options.model } : {}),
      thinking: task.expected.json_schema ? false : options.thinking,
      ...(task.expected.json_schema ? { responseFormat: "json_object" as const } : {}),
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
    const usage = measured.usage
    const output = measured.output.trim()
    const failures = validateCase(task, output, usage, cacheEvaluation)
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
      primaryCause,
      optimization: primaryCause ? optimizationForCause(primaryCause) : undefined,
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
