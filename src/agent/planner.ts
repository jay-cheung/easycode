import type { Provider } from "../provider/types"
import type { ProviderInputMessage } from "../message"
import type { ContextManagerLike } from "../context/types"
import { ledgerRecord } from "./ledger"
import { ProjectMemoryStore } from "../memory"
import type { ExecutionPlan, PlanStepStatus } from "../plans"
import { saveStructuredPlan } from "../plans"

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
    const parsed = JSON.parse(jsonText.trim())
    if (!parsed.id) parsed.id = `plan_${Date.now()}`
    if (!parsed.title) parsed.title = "Implementation Plan"
    if (!Array.isArray(parsed.steps)) parsed.steps = []
    
    parsed.steps = parsed.steps.map((step: any, index: number) => {
      const id = step.id || `step_${index + 1}`
      const goal = step.goal || "Goal not specified"
      const kind = ["inspect", "edit", "verify", "document", "gate"].includes(step.kind) ? step.kind : "inspect"
      return {
        id,
        goal,
        kind,
        targetFiles: Array.isArray(step.targetFiles) ? step.targetFiles : [],
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
        doneWhen: step.doneWhen || "",
        fallback: step.fallback || ""
      }
    })
    return parsed as ExecutionPlan
  } catch (error) {
    return {
      id: `plan_${Date.now()}`,
      title: "Generated Plan (Fallback)",
      steps: [
        {
          id: "step_1",
          goal: "Execute the approved plan.",
          kind: "edit",
          doneWhen: "All modifications completed and verified."
        }
      ]
    }
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
  "steps": [
    {
      "id": "step_1",
      "goal": "Descriptive goal for this step",
      "kind": "inspect" | "edit" | "verify" | "document" | "gate",
      "targetFiles": ["file1.ts", "file2.ts"],
      "dependsOn": [],
      "doneWhen": "Conditions under which this step is considered done",
      "fallback": "What to do if this step fails"
    }
  ]
}

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
  "steps": [
    ...
  ]
}

Only return the JSON object, wrapped in a markdown code block: \`\`\`json ... \`\`\`. Do not output any other text or explanation.`

    const userPrompt = `Replan request.`
    const rawResponse = await askProvider(provider, userPrompt, systemPrompt)
    return parseExecutionPlanFromResponse(rawResponse)
  }
}

export class PlanTracker {
  static async updateStepStatus(
    context: ContextManagerLike,
    root: string,
    sessionId: string,
    plan: ExecutionPlan,
    stepStatuses: Record<string, PlanStepStatus>,
    activeStepId: string,
    status: PlanStepStatus,
    details?: { blocker?: string; verificationTarget?: string; replanReason?: string }
  ): Promise<void> {
    const turn = context.state.messages.length
    stepStatuses[activeStepId] = status
    
    const records = [
      ledgerRecord("checkpoint", "current_plan_id", plan.id, "current", turn),
      ledgerRecord("checkpoint", "current_plan_step", activeStepId, "current", turn),
      ledgerRecord("checkpoint", "plan_step_status", status, "current", turn),
    ]
    
    if (details?.blocker) {
      records.push(ledgerRecord("checkpoint", "plan_blocker", details.blocker, "current", turn))
    } else {
      records.push(ledgerRecord("checkpoint", "plan_blocker", "none", "current", turn))
    }
    if (details?.verificationTarget) {
      records.push(ledgerRecord("checkpoint", "plan_verification_target", details.verificationTarget, "current", turn))
    }
    if (details?.replanReason) {
      records.push(ledgerRecord("checkpoint", "plan_last_replan_reason", details.replanReason, "current", turn))
    }
    
    context.updateLedger({ current: records })
    
    // Save updated structured plan to disk (along with step statuses)
    await saveStructuredPlan(root, sessionId, plan.id, plan)
    
    // Update checkpoint in memory
    await this.writeMemoryCheckpoint(root, plan, stepStatuses, activeStepId, details?.blocker)
  }

  static async writeMemoryCheckpoint(
    root: string,
    plan: ExecutionPlan,
    stepStatuses: Record<string, PlanStepStatus>,
    activeStepId: string,
    blocker?: string
  ): Promise<void> {
    const store = new ProjectMemoryStore(root)
    const allRecords = await store.list()
    const targetTag = `plan_${plan.id}`
    for (const record of allRecords) {
      if (record.kind === "task_state" && record.tags.includes(targetTag)) {
        await store.delete(record.id)
      }
    }
    
    const completedPhases = plan.steps
      .filter(step => stepStatuses[step.id] === "completed")
      .map(step => step.id)
      .join(", ") || "none"
      
    const activeStep = plan.steps.find(step => step.id === activeStepId)
    const nextStepGoal = activeStep ? activeStep.goal : "none"
    
    const checkpointText = `Task: ${plan.title || "Implementation"}. Completed phases: ${completedPhases}. Current blocker: ${blocker || "none"}. Next step: ${nextStepGoal}.`
    
    await store.add({
      text: checkpointText,
      kind: "task_state",
      tags: ["task", "checkpoint", targetTag],
      scope: { topics: ["task_checkpoint", plan.id] }
    })
  }

  static async clearActivePlan(
    context: ContextManagerLike,
    root: string,
    planId: string
  ): Promise<void> {
    const turn = context.state.messages.length
    
    // Transition all active plan records to resolved/archived
    const currentRecords = context.state.ledger?.current || []
    const nextCurrent = currentRecords.filter(r => 
      !["current_plan_id", "current_plan_step", "plan_step_status", "plan_blocker", "plan_verification_target", "plan_last_replan_reason"].includes(r.subject)
    )
    const nextHistory = (context.state.ledger?.history || []).concat(
      currentRecords
        .filter(r => ["current_plan_id", "current_plan_step", "plan_step_status", "plan_blocker", "plan_verification_target", "plan_last_replan_reason"].includes(r.subject))
        .map(r => ({ ...r, status: "resolved" as const, updatedAtTurn: turn }))
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
}
