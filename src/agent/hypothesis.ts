export type ActiveHypothesis = {
  summary: string
  normalized: string
  evidenceRevision: number
  updatedAtTurn: number
}

export type HypothesisViolation = {
  kind: "multiple_hypotheses_same_turn" | "changed_without_new_evidence"
  message: string
  candidates: string[]
  activeSummary?: string
}

export function evaluateHypothesisTurn(input: {
  reasoningText: string
  text: string
  toolCallCount: number
  activeHypothesis?: ActiveHypothesis
  evidenceRevision: number
}) {
  const sourceText = [input.reasoningText, input.toolCallCount > 0 ? input.text : ""].filter(Boolean).join("\n")
  const candidates = extractHypothesisCandidates(sourceText)
  if (candidates.length === 0) return {}
  if (candidates.length > 1) {
    return {
      violation: {
        kind: "multiple_hypotheses_same_turn" as const,
        message: `Multiple competing hypotheses appeared in one turn without new evidence: ${candidates.map((candidate) => `"${candidate.summary}"`).join(" -> ")}`,
        candidates: candidates.map((candidate) => candidate.summary),
        activeSummary: input.activeHypothesis?.summary,
      },
    }
  }
  const next = candidates[0]
  if (
    input.activeHypothesis
    && next.normalized !== input.activeHypothesis.normalized
    && input.evidenceRevision <= input.activeHypothesis.evidenceRevision
  ) {
    return {
      violation: {
        kind: "changed_without_new_evidence" as const,
        message: `Changed active hypothesis from "${input.activeHypothesis.summary}" to "${next.summary}" without new evidence.`,
        candidates: [next.summary],
        activeSummary: input.activeHypothesis.summary,
      },
    }
  }
  return { nextHypothesis: next }
}

export function extractHypothesisCandidates(text: string) {
  const seen = new Set<string>()
  const candidates: Array<{ summary: string; normalized: string }> = []
  for (const sentence of splitSentences(text)) {
    if (!looksLikeHypothesis(sentence)) continue
    const normalized = normalizeHypothesis(sentence)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    candidates.push({ summary: sentence, normalized })
  }
  return candidates
}

export function normalizeHypothesis(text: string) {
  return text
    .toLowerCase()
    .replace(/\b(wait|actually|let me re-?read|let me re-?examine|maybe|perhaps|i think|i guess|i wonder if|it seems|hmm)\b/g, " ")
    .replace(/[^\w\s./#:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function splitSentences(text: string) {
  return text
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

function looksLikeHypothesis(text: string) {
  const hasDiagnosisSignal = /\b(root cause|cause|bug|issue|problem|failure|failing|culprit)\b/i.test(text)
  const hasResolutionSignal = /\b(the|this|current)?\s*(fix|solution)\s+(is|are|was|will be|should be|must be)\b/i.test(text)
  const hasCoreSignal = hasDiagnosisSignal || hasResolutionSignal
  if (!hasCoreSignal) return false
  const processOnly =
    /\b(inspect|check|re-?read|read|search|look|verify|test|review)\b/i.test(text)
    && !hasCoreSignal
  if (processOnly) return false
  return /( is | are | should | need to | must | will | maybe | perhaps | could be | might be )/i.test(` ${text.toLowerCase()} `)
}
