import type { Provider } from "../provider/types"
import type { ProviderInputMessage } from "../message"
import type { ContextManagerLike } from "../context/types"
import type { ContextLedger, StructuredContextLedger } from "../context"
import { ledgerRecord } from "./ledger"
import { ProjectMemoryStore } from "../memory"
import type { ExecutionPlan, PlanCheckpoint, PlanStepStatus, ReplanReason, StoredExecutionPlan } from "../plans"
import { createPlanCheckpoint, InvalidExecutionPlanError, nextIncompletePlanStep, normalizeExecutionPlan, saveStructuredPlan } from "../plans"

export const planLedgerSubjects = [
  "current_plan_id",
  "current_plan_step",
  "plan_step_status",
  "plan_blocker",
  "plan_verification_target",
  "plan_last_replan_reason",
  "plan_step_status_map",
  "plan_lifecycle_status",
] as const

export async function askProvider(provider: Provider, prompt: string, systemPrompt?: string): Promise<string> {
  const providerMessages: ProviderInputMessage[] = []
  if (systemPrompt) {
    providerMessages.push({ role: "system", content: systemPrompt })
  }
  providerMessages.push({ role: "user", content: prompt })
  
  const chunks: string[] = []
  for await (const event of provider.stream({
    mode: "build",
    prompt,
    messages: [],
    providerMessages,
    tools: []
  })) {
    if (event.type === "text_delta") {
      chunks.push(event.text)
    }
  }
  return chunks.join("")
}

export function parseExecutionPlanFromResponse(response: string): ExecutionPlan {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/)
  const jsonText = jsonMatch ? jsonMatch[1] : response
  try {
    return normalizeExecutionPlan(JSON.parse(jsonText.trim()) as unknown)
  } catch (error) {
    if (error instanceof InvalidExecutionPlanError) throw error
    throw new InvalidExecutionPlanError("Structured plan response was not valid JSON.")
  }
}

export class Planner {
  static async generateStructuredPlan(
    prompt: string,
    markdownPlan: string,
    provider: Provider
  ): Promise<ExecutionPlan> {
    const systemPrompt = `You are a structured planning parser for EasyCode.
Your task is to take a markdown implementation plan and the user request, and parse/translate them into a structured JSON execution plan.

The JSON format MUST be exactly:
{
  "id": "plan_${Date.now()}",
  "title": "Short descriptive title of the plan",
  "lowRisk": false,
  "steps": [
    {
      "id": "step_1",
      "goal": "Descriptive goal for this step",
      "kind": "inspect" | "edit" | "verify" | "document" | "gate",
      "executorHint": "main" | "subagent",
      "subagentRole": "summary" | "explorer" | "reviewer" | "debugger" | "tester" | "docs_researcher",
      "targetFiles": ["file1.ts", "file2.ts"],
      "dependsOn": [],
      "doneWhen": "Conditions under which this step is considered done",
      "fallback": "What to do if this step fails"
    }
  ]
}

Use executorHint/subagentRole only for hidden internal execution metadata. The user-visible markdown plan must not mention them directly.
If a step is a Delegation Phase step, or the markdown explicitly says to delegate or use a subagent role, you MUST set executorHint to "subagent" and set the matching subagentRole.
Use the named roles consistently:
- explorer: bounded repository inspection or fact-finding
- reviewer: bounded code review or regression review
- debugger: bounded failure diagnosis
- tester: bounded verification or test execution
- docs_researcher: bounded docs/spec research
- summary: context summarization only
Do not leave delegation steps without executor metadata.
Always include lowRisk as a boolean:
- true only for short read-only/review/documentation plans that do not edit files, run risky commands, touch secrets/auth/payment/database/deploy paths, or require debugger/tester execution.
- false for any edit, shell mutation, release/deploy, permission, credential, payment, database, migration, broad refactor, or uncertain-risk work.

Only return the JSON object, wrapped in a markdown code block: \`\`\`json ... \`\`\`. Do not output any other text or explanation.`

    const userPrompt = `User Request: ${prompt}\n\nMarkdown Plan:\n${markdownPlan}`
    const rawResponse = await askProvider(provider, userPrompt, systemPrompt)
    return parseExecutionPlanFromResponse(rawResponse)
  }
}

export class Replanner {
  static async replan(
    prompt: string,
    currentPlan: ExecutionPlan,
    stepStatuses: Record<string, PlanStepStatus>,
    failedStepId: string,
    reason: string,
    provider: Provider
  ): Promise<ExecutionPlan> {
    const systemPrompt = `You are a structured replanning agent for EasyCode.
We are executing a structured plan, but a step has failed or the user has changed the scope. You need to rewrite the remaining steps of the plan based on the failure reason, scope change, and current evidence.

Here is the current ExecutionPlan JSON:
${JSON.stringify(currentPlan, null, 2)}

Step Statuses:
${JSON.stringify(stepStatuses, null, 2)}

Failed/Active Step ID: ${failedStepId || "none"}
Failure Reason/Evidence: ${reason}
New Scope or Goal (if any): ${prompt}

Generate a revised JSON ExecutionPlan. Keep completed steps as is (do not modify them, keep them in the JSON list with their original IDs), and rewrite or insert new steps starting from the failed/active step.
The JSON format must strictly match:
{
  "id": "${currentPlan.id}",
  "title": "${currentPlan.title}",
  "lowRisk": false,
  "steps": [
    ...
  ]
}

You may keep or revise hidden internal executor metadata (\`executorHint\`, \`subagentRole\`) when it helps execution, but user-visible markdown will not show those fields.
Always include lowRisk as a boolean. Use false unless the revised remaining work is short, read-only/review/documentation-only, and does not require debugger/tester, risky commands, edits, deploys, credentials, auth, payment, or database work.

Only return the JSON object, wrapped in a markdown code block: \`\`\`json ... \`\`\`. Do not output any other text or explanation.`

    const userPrompt = `Replan request.`
    const rawResponse = await askProvider(provider, userPrompt, systemPrompt)
    const newPlan = parseExecutionPlanFromResponse(rawResponse)
    newPlan.id = currentPlan.id

    // Validate completed steps were not modified by the replan
    for (const step of currentPlan.steps) {
      if (stepStatuses[step.id] === "completed") {
        const newStep = newPlan.steps.find(s => s.id === step.id)
        if (!newStep) {
          throw new InvalidExecutionPlanError(`Replan removed completed step '${step.id}'. Completed steps must be preserved.`)
        }
        if (newStep.goal !== step.goal || newStep.kind !== step.kind) {
          throw new InvalidExecutionPlanError(
            `Replan modified completed step '${step.id}': goal or kind changed. Completed steps must remain unchanged.`
          )
        }
      }
    }

    return newPlan
  }
}

export class PlanTracker {
  static async activatePlan(
    context: ContextManagerLike,
    root: string,
    sessionId: string,
    plan: ExecutionPlan,
    checkpointInput: Partial<PlanCheckpoint> = {},
  ): Promise<StoredExecutionPlan> {
    const checkpoint = createPlanCheckpoint(plan, checkpointInput)
    await this.syncPlanState(context, root, sessionId, plan, checkpoint)
    return { version: 1, plan, checkpoint }
  }

  static async updateStepStatus(
    context: ContextManagerLike,
    root: string,
    sessionId: string,
    plan: ExecutionPlan,
    stepStatuses: Record<string, PlanStepStatus>,
    activeStepId: string,
    status: PlanStepStatus,
    details?: { blocker?: string; verificationTarget?: string; replanReason?: ReplanReason }
  ): Promise<void> {
    const nextStatuses = { ...stepStatuses, [activeStepId]: status }
    const nextStep = nextIncompletePlanStep(plan, nextStatuses)
    const checkpoint = createPlanCheckpoint(plan, {
      currentStepId: status === "completed" ? nextStep?.id : activeStepId,
      stepStatuses: nextStatuses,
      blocker: details?.blocker,
      verificationTarget: details?.verificationTarget,
      lastReplanReason: details?.replanReason,
      status: checkpointStatusFor(status, nextStep?.id),
    })
    await this.syncPlanState(context, root, sessionId, plan, checkpoint)
  }

  static async clearActivePlan(
    context: ContextManagerLike,
    root: string,
    planId: string
  ): Promise<void> {
    const turn = context.state.messages.length
    const activeSubjects = new Set<string>(planLedgerSubjects)
    
    // Transition all active plan records to resolved/archived
    const currentRecords = context.state.ledger?.current || []
    const nextCurrent = currentRecords.filter((record) => !activeSubjects.has(record.subject))
    const nextHistory = (context.state.ledger?.history || []).concat(
      currentRecords
        .filter((record) => activeSubjects.has(record.subject))
        .map((record) => ({ ...record, status: "resolved" as const, updatedAtTurn: turn }))
    )
    context.setLedger({ current: nextCurrent, history: nextHistory })
    
    // Delete checkpoint from memory
    const store = new ProjectMemoryStore(root)
    const allRecords = await store.list()
    const targetTag = `plan_${planId}`
    for (const record of allRecords) {
      if (record.kind === "task_state" && record.tags.includes(targetTag)) {
        await store.delete(record.id)
      }
    }
  }

  private static async syncPlanState(
    context: ContextManagerLike,
    root: string,
    sessionId: string,
    plan: ExecutionPlan,
    checkpoint: PlanCheckpoint,
  ) {
    const turn = context.state.messages.length
    const currentStepStatus = checkpoint.currentStepId ? checkpoint.stepStatuses[checkpoint.currentStepId] ?? "pending" : "completed"
    const records = [
      ledgerRecord("checkpoint", "current_plan_id", plan.id, "current", turn),
      ledgerRecord("checkpoint", "current_plan_step", checkpoint.currentStepId ?? "none", "current", turn),
      ledgerRecord("checkpoint", "plan_step_status", currentStepStatus, "current", turn),
      ledgerRecord("checkpoint", "plan_blocker", checkpoint.blocker ?? "none", "current", turn),
      ledgerRecord("checkpoint", "plan_step_status_map", summarizeStepStatuses(checkpoint.stepStatuses), "current", turn),
      ledgerRecord("checkpoint", "plan_lifecycle_status", checkpoint.status, "current", turn),
    ]
    if (checkpoint.verificationTarget) {
      records.push(ledgerRecord("checkpoint", "plan_verification_target", checkpoint.verificationTarget, "current", turn))
    }
    if (checkpoint.lastReplanReason) {
      records.push(ledgerRecord("checkpoint", "plan_last_replan_reason", checkpoint.lastReplanReason, "current", turn))
    }
    context.updateLedger({ current: records })
    await saveStructuredPlan(root, sessionId, plan.id, plan, checkpoint)
  }
}

export function stripPlanLedger(ledger: StructuredContextLedger | ContextLedger | undefined): StructuredContextLedger | ContextLedger | undefined {
  if (!ledger) return ledger
  const subjects = new Set<string>(planLedgerSubjects)
  const current = (ledger.current ?? []).filter((record) => !subjects.has(record.subject))
  const history = (ledger.history ?? []).filter((record) => !subjects.has(record.subject))
  if (current.length === 0 && history.length === 0) return undefined
  return { current, history }
}

function summarizeStepStatuses(stepStatuses: Record<string, PlanStepStatus>) {
  return Object.entries(stepStatuses).map(([stepID, status]) => `${stepID}:${status}`).join(", ") || "none"
}

function checkpointStatusFor(status: PlanStepStatus, nextStepId: string | undefined): PlanCheckpoint["status"] {
  if (status === "failed" || status === "blocked") return "blocked"
  if (status === "completed" && !nextStepId) return "completed"
  return "running"
}
