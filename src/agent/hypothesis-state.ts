import type { ContextManagerLike } from "../context"
import { ledgerRecord } from "./ledger"
import { normalizeHypothesis, type ActiveHypothesis, type HypothesisViolation } from "./hypothesis"

export function compactLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export function truncateForLedger(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 15))}...[truncated]`
}

export function activeHypothesisFromLedger(ledger: ContextManagerLike["state"]["ledger"]): ActiveHypothesis | undefined {
  const record = ledger?.current?.find((item) => item.kind === "decision" && item.subject === "active_hypothesis")
  if (!record) return undefined
  const normalized = normalizeHypothesis(record.value)
  if (!normalized) return undefined
  return { summary: record.value, normalized, evidenceRevision: 0, updatedAtTurn: record.updatedAtTurn }
}

export function activeHypothesisMessages(activeHypothesis: ActiveHypothesis | undefined) {
  if (!activeHypothesis) return []
  return [{
    role: "system" as const,
    content: `Active hypothesis: ${activeHypothesis.summary}\nKeep executing this hypothesis unless new user or tool evidence appears. Do not replace it without citing the new evidence first.`,
  }]
}

export function updateActiveHypothesisState(
  context: ContextManagerLike,
  current: ActiveHypothesis | undefined,
  summary: string,
  normalized: string,
  evidenceRevision: number,
) {
  const turn = context.state.messages.length
  const next: ActiveHypothesis = {
    summary,
    normalized,
    evidenceRevision,
    updatedAtTurn: turn,
  }
  context.updateLedger({
    current: [
      ledgerRecord("decision", "active_hypothesis", truncateForLedger(summary, 220), "current", turn, {
        reason: `evidence revision ${evidenceRevision}`,
        evidence: { source: "assistant" },
      }),
    ],
  })
  return next
}

export function recordHypothesisViolationState(
  context: ContextManagerLike,
  activeHypothesis: ActiveHypothesis | undefined,
  violation: HypothesisViolation,
) {
  const turn = context.state.messages.length
  context.updateLedger({
    current: [
      ledgerRecord("failure", "hypothesis_drift_violation", truncateForLedger(violation.message, 240), "current", turn, {
        evidence: { source: "assistant" },
        scope: { topics: ["hypothesis_lock"] },
      }),
      ...(activeHypothesis
        ? [ledgerRecord("decision", "active_hypothesis", truncateForLedger(activeHypothesis.summary, 220), "current", turn, {
            reason: "kept active after drift violation",
            evidence: { source: "assistant" },
          })]
        : []),
    ],
  })
}

export function recordRunIntentState(context: ContextManagerLike, prompt: string) {
  const normalized = compactLine(prompt)
  if (!normalized) return
  const turn = context.state.messages.length
  context.updateLedger({
    current: [
      ledgerRecord("intent", "current_user_request", truncateForLedger(normalized, 240), "current", turn, { evidence: { source: "user", messageIndex: Math.max(0, turn - 1) } }),
      ledgerRecord("constraint", "main_objective", "complete latest request end-to-end; do not shrink scope unless user changes it.", "current", turn),
      ledgerRecord("constraint", "efficient_tool_usage", "do not repeatedly call read or search on the same path/query; reuse previous results and trust your findings.", "current", turn),
      ledgerRecord("constraint", "failure_recovery_rule", "after tool failure, keep objective and take nearest safe recovery.", "current", turn),
      ledgerRecord("constraint", "full_scope_finality", "do not treat probes, subsets, or dry runs as final for full-scope requests.", "current", turn),
      ledgerRecord("constraint", "evidence_grounding", "do not claim evidence unless it is in messages, summary, ledger, files, or tool outputs.", "current", turn),
      ledgerRecord("constraint", "hypothesis_lock", "once a concrete diagnosis or change hypothesis is formed, keep it until new user or tool evidence justifies changing it.", "current", turn),
    ],
  })
}

export function hypothesisCorrectionMessage(violation: HypothesisViolation, activeHypothesis: ActiveHypothesis | undefined) {
  const active = activeHypothesis ? `Current active hypothesis: "${activeHypothesis.summary}".` : "No replacement hypothesis is allowed without new evidence."
  return [
    "Hypothesis discipline violation detected.",
    violation.message,
    active,
    "Return one concrete hypothesis only.",
    "If you need to change it, first cite the new user or tool evidence that justifies the change.",
  ].join("\n")
}
