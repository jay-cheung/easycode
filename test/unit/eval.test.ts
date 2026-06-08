import { describe, expect, test } from "bun:test"
import { failureReasonForEvalResult } from "../../dev/quality/eval"
import type { AgentRunResult } from "../../src/agent"

describe("eval failure reasons", () => {
  test("preserves provider failure text for non-completed runs", () => {
    const result: AgentRunResult = {
      status: "failed",
      failureReason: "provider_error",
      text: "DeepSeek API failed: unable to get local issuer certificate\nextra detail",
      messages: [],
      usedTools: [],
      state: "failed",
    }

    expect(failureReasonForEvalResult(result)).toBe("run failed: DeepSeek API failed: unable to get local issuer certificate")
  })

  test("returns undefined for completed runs", () => {
    const result: AgentRunResult = {
      status: "completed",
      text: "easycode real eval ok",
      messages: [],
      usedTools: [],
      state: "completed",
    }

    expect(failureReasonForEvalResult(result)).toBeUndefined()
  })
})
