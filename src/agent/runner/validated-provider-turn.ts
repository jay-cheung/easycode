import { evaluateHypothesisTurn, type ActiveHypothesis, type HypothesisViolation } from "../hypothesis"
import type { ProviderTurnInput, ProviderTurnResult } from "./provider-turn"

export type TurnValidationFailure = {
  correction: string
  failureText: string
}

export type TurnValidationObservation = {
  failure: TurnValidationFailure
  attempts: number
  maxAttempts: number
  shouldRetry: boolean
  turn: ProviderTurnResult
}

type ValidatedProviderTurnDeps = {
  runProviderTurn: (input: ProviderTurnInput) => Promise<ProviderTurnResult>
  emitProviderTurn: (turn: ProviderTurnResult) => void
  updateActiveHypothesis: (summary: string, normalized: string) => void
  recordHypothesisViolation: (violation: HypothesisViolation) => void
  reportTurnValidationFailure?: (observation: TurnValidationObservation) => void
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
    const providerMessages = providerMessagesWithCorrections(input.providerMessages, correctionMessages)
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
      const rejection = nextTurnValidationRejection(deps.validateTurn, turn, turnValidationAttempts, maxTurnValidationAttempts)
      if (rejection) {
        deps.reportTurnValidationFailure?.({
          failure: rejection.failure,
          attempts: rejection.attempts,
          maxAttempts: maxTurnValidationAttempts,
          shouldRetry: rejection.shouldRetry,
          turn,
        })
        lastTurnValidationFailure = rejection.failure
        turnValidationAttempts = rejection.attempts
        if (rejection.shouldRetry) correctionMessages.push(rejection.failure.correction)
        else break
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
      failureText: undefined,
      retryMessage: lastTurnValidationFailure.correction,
      validationFailureCount: turnValidationAttempts,
      lastRejectedTurn: {
        text: fallbackTurn.text,
        reasoningText: fallbackTurn.reasoningText,
        toolNames: fallbackTurn.toolCalls.map((call) => call.name),
      },
      replayEvents: [],
    }
  }
  deps.emitProviderTurn(fallbackTurn)
  return fallbackTurn
}

function providerMessagesWithCorrections(
  providerMessages: ProviderTurnInput["providerMessages"],
  correctionMessages: string[],
) {
  if (correctionMessages.length === 0) return providerMessages
  const existingSystemContents = new Set(
    providerMessages
      .filter((message) => message.role === "system")
      .map((message) => message.content),
  )
  const dedupedCorrections = [...new Set(correctionMessages)].filter((content) => !existingSystemContents.has(content))
  if (dedupedCorrections.length === 0) return providerMessages
  return [
    ...providerMessages,
    ...dedupedCorrections.map((content) => ({ role: "system" as const, content })),
  ]
}

function nextTurnValidationRejection(
  validateTurn: ValidatedProviderTurnDeps["validateTurn"],
  turn: ProviderTurnResult,
  turnValidationAttempts: number,
  maxTurnValidationAttempts: number,
) {
  const failure = validateTurn?.(turn)
  if (!failure) return undefined
  const attempts = turnValidationAttempts + 1
  return {
    failure,
    attempts,
    shouldRetry: attempts < maxTurnValidationAttempts,
  }
}
