import path from "node:path"
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
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
      .map((f) => ({ name: f, mtime: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
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

function extractPlanId(markdown: string): string | undefined {
  const jsonMatch = markdown.match(/```json\s*([\s\S]*?)\s*```/)
  const jsonText = jsonMatch ? jsonMatch[1] : undefined
  if (!jsonText) return undefined
  try {
    const parsed = JSON.parse(jsonText.trim())
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      return parsed.id.trim()
    }
  } catch {
    // ignore parsing errors
  }
  return undefined
}

export async function savePlan(root: string, sessionId: string, planMarkdown: string): Promise<string | undefined> {
  if (!planMarkdown) return
  const dir = planStoreDir(root, sessionId)
  mkdirSync(dir, { recursive: true })
  const planId = extractPlanId(planMarkdown)
  const filename = planId ? `${safePlanSegment(planId)}.md` : `${Date.now()}.md`
  const filePath = path.join(dir, filename)

  await Bun.write(filePath, stripPlanTags(planMarkdown))
  cleanupOldPlans(dir)
  return filePath
}

export type PlanStepKind = "inspect" | "edit" | "verify" | "document" | "gate"
export type PlanStepExecutorHint = "main" | "subagent"

export interface PlanStep {
  id: string
  goal: string
  kind: PlanStepKind
  executorHint?: PlanStepExecutorHint
  subagentRole?: "summary" | "explorer" | "reviewer" | "debugger" | "tester" | "docs_researcher"
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
  lowRisk: boolean
}

export type ReplanReason = "tool_failure" | "verification_failure" | "scope_change" | "new_evidence"

export type PlanLifecycleStatus = "draft" | "running" | "blocked" | "completed"

export interface PlanCheckpoint {
  currentStepId?: string
  stepStatuses: Record<string, PlanStepStatus>
  blocker?: string
  verificationTarget?: string
  lastReplanReason?: ReplanReason
  status: PlanLifecycleStatus
}

export interface StoredExecutionPlan {
  version: 1
  plan: ExecutionPlan
  checkpoint: PlanCheckpoint
}

export class InvalidExecutionPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidExecutionPlanError"
  }
}

export function normalizeExecutionPlan(input: unknown): ExecutionPlan {
  if (!input || typeof input !== "object") throw new InvalidExecutionPlanError("Structured plan must be a JSON object.")
  const raw = input as Record<string, unknown>
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `plan_${Date.now()}`
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Implementation Plan"
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new InvalidExecutionPlanError("Structured plan must contain at least one step.")
  }
  const steps = raw.steps.map(normalizePlanStep)
  const lowRisk = typeof raw.lowRisk === "boolean" ? raw.lowRisk : inferLowRiskPlan(raw, steps)

  // Validate dependsOn references exist
  const stepIds = new Set(steps.map((s) => s.id))
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep)) {
        throw new InvalidExecutionPlanError(`Plan step '${step.id}' depends on non-existent step '${dep}'.`)
      }
    }
  }

  // Validate no circular dependencies
  const visited = new Map<string, "visiting" | "visited">()
  const stepMap = new Map(steps.map((s) => [s.id, s]))
  function checkCycle(stepId: string): void {
    if (visited.get(stepId) === "visiting") {
      throw new InvalidExecutionPlanError(`Circular dependency detected in plan involving step '${stepId}'.`)
    }
    if (visited.get(stepId) === "visited") return
    visited.set(stepId, "visiting")
    const step = stepMap.get(stepId)
    if (step) {
      for (const dep of step.dependsOn ?? []) {
        checkCycle(dep)
      }
    }
    visited.set(stepId, "visited")
  }
  for (const step of steps) {
    checkCycle(step.id)
  }

  return { id, title, steps, lowRisk }
}

function inferLowRiskPlan(raw: Record<string, unknown>, steps: PlanStep[]) {
  const text = [
    typeof raw.title === "string" ? raw.title : "",
    ...steps.flatMap((step) => [step.goal, step.doneWhen ?? "", step.fallback ?? "", ...(step.targetFiles ?? [])]),
  ].join("\n").toLowerCase()
  if (steps.length > 3) return false
  if (steps.some((step) => step.kind === "edit" || step.kind === "gate")) return false
  if (steps.some((step) => step.executorHint === "subagent" && (step.subagentRole === "debugger" || step.subagentRole === "tester"))) return false
  if (/\b(delete|remove|migrate|release|deploy|publish|permission|credential|secret|token|env|payment|billing|auth|prod|production|database|schema|destructive|rollback)\b|删除|迁移|发布|部署|权限|凭证|密钥|生产|数据库|破坏/.test(text)) return false
  return steps.every((step) => step.kind === "inspect" || step.kind === "verify" || step.kind === "document")
}

function normalizePlanStep(input: unknown, index: number): PlanStep {
  if (!input || typeof input !== "object") {
    throw new InvalidExecutionPlanError(`Plan step ${index + 1} must be an object.`)
  }
  const raw = input as Record<string, unknown>
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `step_${index + 1}`
  const goal = typeof raw.goal === "string" && raw.goal.trim() ? raw.goal.trim() : ""
  if (!goal) throw new InvalidExecutionPlanError(`Plan step ${id} is missing a goal.`)
  const kind = normalizePlanStepKind(raw.kind)
  const targetFiles = normalizeStringArray(raw.targetFiles)
  const dependsOn = normalizeStringArray(raw.dependsOn)
  const doneWhen = typeof raw.doneWhen === "string" ? raw.doneWhen.trim() : ""
  const fallback = typeof raw.fallback === "string" ? raw.fallback.trim() : ""
  const subagentRole = normalizeSubagentRole(raw.subagentRole) ?? inferSubagentRole(goal, kind, doneWhen, fallback)
  const executorHint = normalizeExecutorHint(raw.executorHint) ?? (subagentRole ? "subagent" : inferExecutorHint(goal, kind, doneWhen, fallback))
  return {
    id,
    goal,
    kind,
    ...(executorHint ? { executorHint } : {}),
    ...(subagentRole ? { subagentRole } : {}),
    ...(targetFiles.length > 0 ? { targetFiles } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(fallback ? { fallback } : {}),
  }
}

function normalizePlanStepKind(value: unknown): PlanStepKind {
  return value === "inspect" || value === "edit" || value === "verify" || value === "document" || value === "gate"
    ? value
    : "inspect"
}

function normalizeExecutorHint(value: unknown): PlanStepExecutorHint | undefined {
  return value === "main" || value === "subagent" ? value : undefined
}

function normalizeSubagentRole(value: unknown): PlanStep["subagentRole"] | undefined {
  return value === "summary" || value === "explorer" || value === "reviewer" || value === "debugger" || value === "tester" || value === "docs_researcher"
    ? value
    : undefined
}

function inferSubagentRole(goal: string, kind: PlanStepKind, doneWhen: string, fallback: string): PlanStep["subagentRole"] | undefined {
  const text = `${goal}\n${doneWhen}\n${fallback}`.toLowerCase()
  if (/\bdocs(?:_|-|\s)?researcher\b/.test(text)) return "docs_researcher"
  if (/\bexplorer\b/.test(text)) return "explorer"
  if (/\breviewer\b/.test(text)) return "reviewer"
  if (/\bdebugger\b/.test(text)) return "debugger"
  if (/\btester\b/.test(text)) return "tester"
  if (/\bsummary\b/.test(text)) return "summary"
  if (!/\bdelegate\b|delegate_subagent|subagent|委派|子\s*agent/i.test(text)) return undefined
  if (/\b(web_fetch|web_search|https?:\/\/|api\b|http\b|public data|external docs?|external spec|data source|mcp|connector|fetch data|market data|stock data)\b|公开\s*api|外部接口|外部资料|数据源|网页|抓取|行情/i.test(text)) return "docs_researcher"
  if (kind === "verify" || kind === "gate") return "tester"
  if (/\breview\b|审查|评审/i.test(text)) return "reviewer"
  if (/\b(debug|diagnos|trace|repro|crash|error|failure|flake|flaky|logs?)\b|调试|排查|定位|复现|报错|错误|失败|日志/i.test(text)) return "debugger"
  if (/\bdocs?\b|文档|spec/i.test(text)) return "docs_researcher"
  if (kind === "inspect") return "explorer"
  return undefined
}

function inferExecutorHint(goal: string, kind: PlanStepKind, doneWhen: string, fallback: string): PlanStepExecutorHint | undefined {
  const text = `${goal}\n${doneWhen}\n${fallback}`.toLowerCase()
  if (/\bdelegate\b|delegate_subagent|subagent|委派|子\s*agent/i.test(text)) return "subagent"
  if ((kind === "inspect" || kind === "verify" || kind === "gate") && /\bresearch\b|调研|review|审查|评审|debug|排查|定位|test|验证/i.test(text)) {
    return "subagent"
  }
  return undefined
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
}

export function nextIncompletePlanStep(plan: ExecutionPlan, stepStatuses: Record<string, PlanStepStatus>) {
  for (const step of plan.steps) {
    if (stepStatuses[step.id] === "completed") continue
    if ((step.dependsOn ?? []).every((dependency) => stepStatuses[dependency] === "completed")) return step
  }
  return undefined
}

export function createPlanCheckpoint(plan: ExecutionPlan, input: Partial<PlanCheckpoint> = {}): PlanCheckpoint {
  const stepStatuses: Record<string, PlanStepStatus> = {}
  for (const step of plan.steps) {
    stepStatuses[step.id] = input.stepStatuses?.[step.id] ?? "pending"
  }
  const currentStep = typeof input.currentStepId === "string" && input.currentStepId.trim()
    ? plan.steps.find((step) => step.id === input.currentStepId)
    : nextIncompletePlanStep(plan, stepStatuses)
  return {
    currentStepId: currentStep?.id,
    stepStatuses,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.verificationTarget ? { verificationTarget: input.verificationTarget } : {}),
    ...(input.lastReplanReason ? { lastReplanReason: input.lastReplanReason } : {}),
    status: input.status ?? "draft",
  }
}

function normalizeStoredExecutionPlan(input: unknown): StoredExecutionPlan {
  if (!input || typeof input !== "object") throw new InvalidExecutionPlanError("Stored structured plan must be a JSON object.")
  const raw = input as Record<string, unknown>
  const plan = normalizeExecutionPlan("plan" in raw ? raw.plan : raw)
  const checkpoint = createPlanCheckpoint(plan, normalizeCheckpointInput(raw.checkpoint))
  return { version: 1, plan, checkpoint }
}

function normalizeCheckpointInput(value: unknown): Partial<PlanCheckpoint> {
  if (!value || typeof value !== "object") return {}
  const raw = value as Record<string, unknown>
  const status = raw.status === "draft" || raw.status === "running" || raw.status === "blocked" || raw.status === "completed"
    ? raw.status
    : undefined
  return {
    ...(typeof raw.currentStepId === "string" && raw.currentStepId.trim() ? { currentStepId: raw.currentStepId.trim() } : {}),
    ...(raw.stepStatuses && typeof raw.stepStatuses === "object" ? { stepStatuses: normalizePlanStepStatuses(raw.stepStatuses as Record<string, unknown>) } : {}),
    ...(typeof raw.blocker === "string" && raw.blocker.trim() ? { blocker: raw.blocker.trim() } : {}),
    ...(typeof raw.verificationTarget === "string" && raw.verificationTarget.trim() ? { verificationTarget: raw.verificationTarget.trim() } : {}),
    ...(typeof raw.lastReplanReason === "string" && isReplanReason(raw.lastReplanReason) ? { lastReplanReason: raw.lastReplanReason } : {}),
    ...(status ? { status } : {}),
  }
}

function normalizePlanStepStatuses(value: Record<string, unknown>) {
  const statuses: Record<string, PlanStepStatus> = {}
  for (const [key, status] of Object.entries(value)) {
    if (!key.trim()) continue
    if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "blocked") {
      statuses[key] = status
    }
  }
  return statuses
}

function isReplanReason(value: string): value is ReplanReason {
  return value === "tool_failure" || value === "verification_failure" || value === "scope_change" || value === "new_evidence"
}

function serializeStoredExecutionPlan(plan: ExecutionPlan | StoredExecutionPlan, checkpoint?: PlanCheckpoint): StoredExecutionPlan {
  if (isStoredExecutionPlan(plan)) return normalizeStoredExecutionPlan(plan)
  const normalizedPlan = normalizeExecutionPlan(plan)
  return {
    version: 1,
    plan: normalizedPlan,
    checkpoint: createPlanCheckpoint(normalizedPlan, checkpoint),
  }
}

function isStoredExecutionPlan(value: ExecutionPlan | StoredExecutionPlan): value is StoredExecutionPlan {
  return "plan" in value && "checkpoint" in value
}

export async function saveStructuredPlan(
  root: string,
  sessionId: string,
  planId: string,
  plan: ExecutionPlan | StoredExecutionPlan,
  checkpoint?: PlanCheckpoint,
): Promise<string> {
  const dir = planStoreDir(root, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${planId}.json`)
  const stored = serializeStoredExecutionPlan(plan, checkpoint)
  await Bun.write(filePath, JSON.stringify(stored, null, 2))
  return filePath
}

export async function loadStructuredPlan(root: string, sessionId: string, planId: string): Promise<ExecutionPlan | undefined> {
  const stored = await loadStructuredPlanState(root, sessionId, planId)
  return stored?.plan
}

export async function loadStructuredPlanState(root: string, sessionId: string, planId: string): Promise<StoredExecutionPlan | undefined> {
  const dir = planStoreDir(root, sessionId)
  const filePath = path.join(dir, `${planId}.json`)
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  try {
    return normalizeStoredExecutionPlan(JSON.parse(await file.text()) as unknown)
  } catch {
    return undefined
  }
}

export function isComplexPlan(plan: ExecutionPlan): boolean {
  return plan.steps.some((step) => step.kind === "edit")
}

export function isPlanApprovalPrompt(prompt: string) {
  const normalized = prompt.trim()
  return normalized === "Proceed with the approved plan." ||
    normalized === "Proceed." ||
    normalized === "确认" ||
    normalized === "执行" ||
    normalized === "执行吧" ||
    /^(y|yes|ok|approve|approved)$/i.test(normalized)
}

export function isPlanRevisionPrompt(prompt: string) {
  return /\b(revise|replan|change scope|change the plan|update the plan|different approach|switch approach)\b|修改计划|重新规划|重写计划|调整计划|改变范围|换方案/i.test(prompt)
}

export function renderPlanToMarkdown(plan: ExecutionPlan): string {
  const sanitized = sanitizePlanForDisplay(plan)
  const lines: string[] = []
  lines.push("<proposed_plan>")
  lines.push(`# ${sanitized.title || "Implementation Plan"}`)
  lines.push("")
  lines.push(`- **Low Risk**: ${sanitized.lowRisk ? "true" : "false"}`)
  lines.push("")
  for (const step of sanitized.steps) {
    lines.push(`## Step: ${step.id}`)
    lines.push(`- **Goal**: ${step.goal}`)
    lines.push(`- **Kind**: ${step.kind}`)
    if (step.targetFiles && step.targetFiles.length > 0) {
      lines.push(`- **Target Files**: ${step.targetFiles.join(", ")}`)
    }
    if (step.dependsOn && step.dependsOn.length > 0) {
      lines.push(`- **Depends On**: ${step.dependsOn.join(", ")}`)
    }
    if (step.doneWhen) {
      lines.push(`- **Done When**: ${step.doneWhen}`)
    }
    if (step.fallback) {
      lines.push(`- **Fallback**: ${step.fallback}`)
    }
    lines.push("")
  }
  lines.push("```json")
  lines.push(JSON.stringify(sanitized, null, 2))
  lines.push("```")
  lines.push("</proposed_plan>")
  return lines.join("\n")
}

export function sanitizePlanForDisplay(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map(({ executorHint: _executorHint, subagentRole: _subagentRole, ...step }) => step),
  }
}
