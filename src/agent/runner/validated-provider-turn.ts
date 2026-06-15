import { evaluateHypothesisTurn, type ActiveHypothesis, type HypothesisViolation } from "../hypothesis"
import type { ProviderTurnInput, ProviderTurnResult } from "./provider-turn"

export type TurnValidationFailure = {
  correction: string
  failureText: string
}

type ValidatedProviderTurnDeps = {
  runProviderTurn: (input: ProviderTurnInput) => Promise<ProviderTurnResult>
  emitProviderTurn: (turn: ProviderTurnResult) => void
  updateActiveHypothesis: (summary: string, normalized: string) => void
  recordHypothesisViolation: (violation: HypothesisViolation) => void
  hypothesisCorrectionMessage: (violation: HypothesisViolation, activeHypothesis: ActiveHypothesis | undefined) => string
  validateTurn?: (turn: ProviderTurnResult) => TurnValidationFailure | undefined
  activeHypothesis?: ActiveHypothesis
  evidenceRevision: number
}

export async function runValidatedProviderTurnLoop(
  deps: ValidatedProviderTurnDeps,
  input: ProviderTurnInput,
): Promise<ProviderTurnResult> {
  const correctionMessages: string[] = []
  let fallbackTurn: ProviderTurnResult | undefined
  let lastTurnValidationFailure: TurnValidationFailure | undefined
  let hypothesisAttempts = 0
  let turnValidationAttempts = 0
  const maxHypothesisAttempts = 2
  const maxTurnValidationAttempts = deps.validateTurn ? 3 : 0
  while (hypothesisAttempts < maxHypothesisAttempts || turnValidationAttempts < maxTurnValidationAttempts) {
    const providerMessages = correctionMessages.length > 0
      ? [...input.providerMessages, ...correctionMessages.map((content) => ({ role: "system" as const, content }))]
      : input.providerMessages
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
      const turnValidationFailure = deps.validateTurn?.(turn)
      if (turnValidationFailure) {
        lastTurnValidationFailure = turnValidationFailure
        turnValidationAttempts += 1
        if (turnValidationAttempts >= maxTurnValidationAttempts) break
        correctionMessages.push(turnValidationFailure.correction)
        continue
      }
      if (validation.nextHypothesis) deps.updateActiveHypothesis(validation.nextHypothesis.summary, validation.nextHypothesis.normalized)
      deps.emitProviderTurn(turn)
      return turn
    }
    deps.recordHypothesisViolation(validation.violation)
    hypothesisAttempts += 1
    if (hypothesisAttempts >= maxHypothesisAttempts) break
    correctionMessages.push(deps.hypothesisCorrectionMessage(validation.violation, deps.activeHypothesis))
  }
  if (!fallbackTurn) throw new Error("validated provider turn loop completed without a provider turn")
  if (lastTurnValidationFailure) {
    return {
      ...fallbackTurn,
      text: "",
      toolCalls: [],
      failureText: lastTurnValidationFailure.failureText,
      replayEvents: [{ type: "failure", text: lastTurnValidationFailure.failureText }],
    }
  }
  deps.emitProviderTurn(fallbackTurn)
  return fallbackTurn
}
