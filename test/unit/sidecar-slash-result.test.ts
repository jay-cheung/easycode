import { describe, expect, test } from "bun:test"
import { slashResultShouldPersist } from "../../src/sidecar/slash-result"

describe("sidecar slash result persistence", () => {
  test("persists handled slash results only when settings changed", () => {
    expect(slashResultShouldPersist({ handled: false, promptText: "build it" })).toBe(false)
    expect(slashResultShouldPersist({ handled: true, title: "Help", text: "commands" })).toBe(false)
    expect(slashResultShouldPersist({
      handled: true,
      title: "Model",
      text: "Model set.",
      settings: { provider: "fake", thinking: true, effort: "high", language: "en", maxTokens: 32_000, maxSteps: 66, selectedSkills: [], pendingSkillLoads: [] },
    })).toBe(true)
  })
})
