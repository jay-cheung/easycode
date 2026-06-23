import type { ContextManagerLike } from "../context"
import { hasProposedPlanText } from "../agent"
import type { Message } from "../message"
import type { GoalState } from "../goal"

export function currentPlanID(context: ContextManagerLike) {
  return currentLedgerValue(context, "current_plan_id")
}

export function currentPlanStatus(context: ContextManagerLike) {
  return currentLedgerValue(context, "plan_lifecycle_status")
}

export function currentPlanBlocker(context: ContextManagerLike) {
  const blocker = currentLedgerValue(context, "plan_blocker")
  return blocker && blocker !== "none" ? blocker : undefined
}

export function currentLedgerValue(context: ContextManagerLike, subject: string) {
  return context.state.ledger?.current.find((record) => record.subject === subject && record.status === "current")?.value
}

export function toolResultsSince(messages: Message[], startIndex: number) {
  const results: Array<{ toolName: string; output: string; metadata: Record<string, unknown>; status: string }> = []
  for (const message of messages.slice(startIndex)) {
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue
      results.push({ toolName: part.toolName, output: part.output, metadata: part.metadata, status: part.status })
    }
  }
  return results
}

export function firstDeniedToolResult(results: ReturnType<typeof toolResultsSince>) {
  return results.find((result) => result.status === "denied")
}

export function latestGoalToolResult(results: ReturnType<typeof toolResultsSince>) {
  return [...results].reverse().find((result) => result.toolName === "goal_complete" || result.toolName === "goal_blocked")
}

export function latestGoalAcceptanceResult(results: ReturnType<typeof toolResultsSince>) {
  return [...results].reverse().find((result) => result.toolName === "goal_set_acceptance" && result.status === "succeeded")
}

export function shouldCompleteReadOnlyGoalPlanningResult(goal: GoalState, text: string, results: ReturnType<typeof toolResultsSince>) {
  if (goal.status !== "planning") return false
  const summary = text.trim()
  if (!summary || hasProposedPlanText(summary)) return false
  if (looksLikePlanningGateFailure(summary)) return false
  if (results.some((result) => result.status === "failed" || result.status === "denied")) return false

  const taskText = [
    goal.objective,
    goal.firstSlice,
    ...goal.acceptanceCriteria,
    ...goal.completionChecks,
  ].filter(Boolean).join("\n")
  if (!looksLikeReadOnlyGoal(taskText)) return false
  if (looksLikeMutationOrRuntimeGoal(taskText)) return false
  return true
}

function looksLikePlanningGateFailure(text: string) {
  return /planning mode hard gate failed|must submit a proposal plan|must return a proposal plan|return a proposed plan/i.test(text)
}

function looksLikeReadOnlyGoal(text: string) {
  return /\b(review|code review|audit|inspect|explain|analy[sz]e|summari[sz]e|investigat|research)\b|代码评审|代码审查|审查代码|评审代码|复核|审查|评审|检查|查看|分析|解释|说明|调研|排查|当前变更|当前代码/i.test(text)
}

function looksLikeMutationOrRuntimeGoal(text: string) {
  return /\b(implement|fix|repair|change|modify|update|edit|write|create|delete|remove|refactor|commit|stage|apply|patch|test|verify|run|execute|lint|typecheck|build|benchmark|ship)\b|实现|修复|修改|更新|新增|创建|删除|移除|重构|提交|暂存|应用补丁|测试|验证|运行|执行|构建|发布|跑一下/i.test(text)
}
