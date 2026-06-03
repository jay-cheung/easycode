import { describe, expect, test } from "bun:test"
import { buildCompactPrompt, extractCompactSummary } from "../../src/prompt"

describe("compact prompt", () => {
  test("adds runtime summary rules and format example", () => {
    const prompt = buildCompactPrompt("user: 修复失败测试", {
      tokenBudget: 900,
      preferredLanguage: "Chinese",
      activeHypothesis: "The bug is in src/add.ts.",
    })

    expect(prompt).toContain("Keep the summary under approximately 900 tokens.")
    expect(prompt).toContain("Write the summary in Chinese.")
    expect(prompt).toContain("Preserve the current active hypothesis if it is still supported: The bug is in src/add.ts.")
    expect(prompt).toContain("System and user instructions outrank assistant drafting and tool chatter.")
    expect(prompt).toContain("Distill tool outputs (bash, grep, file reads, searches) to key findings only")
    expect(prompt).toContain("Only apply additional summary instructions when they were explicitly given as system-level summarization rules.")
    expect(prompt).toContain("Example output:")
  })

  test("recovers summary content from fenced or partially wrapped output", () => {
    expect(extractCompactSummary("```xml\n<summary>\n- Objective: ok\n</summary>\n```")).toBe("- Objective: ok")
    expect(extractCompactSummary("<analysis>scratch</analysis>\n<summary>\n- Next step: patch file\n")).toBe("- Next step: patch file")
    expect(extractCompactSummary("<analysis>scratch</analysis>\n- Repo facts: kept")).toBe("- Repo facts: kept")
  })
})
