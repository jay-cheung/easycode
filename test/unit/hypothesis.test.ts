import { describe, expect, test } from "bun:test"
import { evaluateHypothesisTurn, extractHypothesisCandidates } from "../../src/agent/hypothesis"

describe("hypothesis detection", () => {
  test("ignores execution-routing sentences that are not diagnostic hypotheses", () => {
    const candidates = extractHypothesisCandidates([
      "Or perhaps I should use the data that was already successfully fetched in an earlier session.",
      "I need to use delegate_subagent role='docs_researcher'.",
      "For 5-minute data, I should use the fetch-intraday.cjs script or fetch directly.",
    ].join("\n"))

    expect(candidates).toEqual([])
  })

  test("still flags multiple competing diagnostic hypotheses", () => {
    const result = evaluateHypothesisTurn({
      reasoningText: "The bug is in src/add.ts. Actually the bug is in test/add.test.ts.",
      text: "",
      toolCallCount: 1,
      evidenceRevision: 0,
    })

    expect(result.violation?.kind).toBe("multiple_hypotheses_same_turn")
  })
})
