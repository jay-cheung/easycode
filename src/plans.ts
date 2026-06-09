import path from "node:path"
import { mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { easycodeDir } from "./easycode-path"

const MAX_PLANS_PER_SESSION = 20

export function planStoreDir(root: string, sessionId: string): string {
  return path.join(easycodeDir(root), "plans", safePlanSegment(sessionId))
}

export function safePlanSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function cleanupOldPlans(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, time: parseInt(f.replace(".md", ""), 10) }))
      .sort((a, b) => b.time - a.time)
    if (files.length > MAX_PLANS_PER_SESSION) {
      for (const file of files.slice(MAX_PLANS_PER_SESSION)) {
        unlinkSync(path.join(dir, file.name))
      }
    }
  } catch {
    /* cleanup failure should not block the user */
  }
}

export function stripPlanTags(text: string): string {
  return text.replace(/<\/?proposed_plan>/gi, "").trim()
}

export async function savePlan(root: string, sessionId: string, planMarkdown: string): Promise<string | undefined> {
  if (!planMarkdown) return
  const dir = planStoreDir(root, sessionId)
  mkdirSync(dir, { recursive: true })
  const timestamp = Date.now()
  const filePath = path.join(dir, `${timestamp}.md`)
  await Bun.write(filePath, stripPlanTags(planMarkdown))
  cleanupOldPlans(dir)
  return filePath
}

export type PlanStepKind = "inspect" | "edit" | "verify" | "document" | "gate"

export interface PlanStep {
  id: string
  goal: string
  kind: PlanStepKind
  targetFiles?: string[]
  dependsOn?: string[]
  doneWhen?: string
  fallback?: string
}

export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "blocked"

export interface ExecutionPlan {
  id: string
  title?: string
  steps: PlanStep[]
}

export type ReplanReason = "tool_failure" | "verification_failure" | "scope_change" | "new_evidence"

export async function saveStructuredPlan(root: string, sessionId: string, planId: string, plan: ExecutionPlan): Promise<string> {
  const dir = planStoreDir(root, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${planId}.json`)
  await Bun.write(filePath, JSON.stringify(plan, null, 2))
  return filePath
}

export async function loadStructuredPlan(root: string, sessionId: string, planId: string): Promise<ExecutionPlan | undefined> {
  const dir = planStoreDir(root, sessionId)
  const filePath = path.join(dir, `${planId}.json`)
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  try {
    return JSON.parse(await file.text()) as ExecutionPlan
  } catch {
    return undefined
  }
}

export function isComplexPlan(plan: ExecutionPlan): boolean {
  return plan.steps.some((step) => step.kind === "edit")
}

