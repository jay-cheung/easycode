import { evaluateHypothesisTurn, type ActiveHypothesis, type HypothesisViolation } from "../hypothesis"
import type { ProviderTurnInput, ProviderTurnResult } from "./provider-turn"

type ValidatedProviderTurnDeps = {
  runProviderTurn: (input: ProviderTurnInput) => Promise<ProviderTurnResult>
  emitProviderTurn: (turn: ProviderTurnResult) => void
  updateActiveHypothesis: (summary: string, normalized: string) => void
  recordHypothesisViolation: (violation: HypothesisViolation) => void
  hypothesisCorrectionMessage: (violation: HypothesisViolation, activeHypothesis: ActiveHypothesis | undefined) => string
  activeHypothesis?: ActiveHypothesis
  evidenceRevision: number
}

export async function runValidatedProviderTurnLoop(
  deps: ValidatedProviderTurnDeps,
  input: ProviderTurnInput,
): Promise<ProviderTurnResult> {
  let correction: string | undefined
  let fallbackTurn: ProviderTurnResult | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const providerMessages = correction ? [...input.providerMessages, { role: "system" as const, content: correction }] : input.providerMessages
    const turn = await deps.runProviderTurn({ ...input, providerMessages, emitDeltas: false })
    fallbackTurn = turn
    const validation = evaluateHypothesisTurn({
      reasoningText: turn.reasoningText,
      text: turn.text,
      toolCallCount: turn.toolCalls.length,
      activeHypothesis: deps.activeHypothesis,
      evidenceRevision: deps.evidenceRevision,
    })
    if (!validation.violation) {
      if (validation.nextHypothesis) deps.updateActiveHypothesis(validation.nextHypothesis.summary, validation.nextHypothesis.normalized)
      deps.emitProviderTurn(turn)
      return turn
    }
    deps.recordHypothesisViolation(validation.violation)
    correction = deps.hypothesisCorrectionMessage(validation.violation, deps.activeHypothesis)
  }
  if (!fallbackTurn) throw new Error("validated provider turn loop completed without a provider turn")
  deps.emitProviderTurn(fallbackTurn)
  return fallbackTurn
}
