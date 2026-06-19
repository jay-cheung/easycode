import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { configuredStartupModel, fetchStartupModelChoices, loadEnvFile, mergeEnvText, missingProviderEnv, needsEnvSetup, parseArgs, parseEnvFile, recentStartupModels, selectStartupModel, shouldCompleteReadOnlyGoalPlanningResult, startupModelChoices, startupProviders } from "../../src/cli"
import { createGoalState } from "../../src/goal"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-cli-"))
}

describe("cli env loading", () => {
  test("parses dotenv entries", () => {
    const parsed = parseEnvFile(`
      # comment
      OPENAI_API_KEY=from-env
      export EASYCODE_MODEL="codex-mini-latest"
      SINGLE='literal value'
      INVALID-KEY=ignored
    `)
    expect(parsed.get("OPENAI_API_KEY")).toBe("from-env")
    expect(parsed.get("EASYCODE_MODEL")).toBe("codex-mini-latest")
    expect(parsed.get("SINGLE")).toBe("literal value")
    expect(parsed.has("INVALID-KEY")).toBe(false)
  })

  test("loads root .env without overriding existing values", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, ".env"), "OPENAI_API_KEY=from-file\nEXISTING=from-file\n")
    const env: Record<string, string | undefined> = { EXISTING: "from-process" }
    expect(await loadEnvFile(root, env)).toBe(1)
    expect(env.OPENAI_API_KEY).toBe("from-file")
    expect(env.EXISTING).toBe("from-process")
    await rm(root, { recursive: true, force: true })
  })

  test("can skip global easycode env loading explicitly", async () => {
    const root = await tmpdir()
    const originalFlag = process.env.EASYCODE_DISABLE_GLOBAL_ENV
    try {
      process.env.EASYCODE_DISABLE_GLOBAL_ENV = "1"
      const env: Record<string, string | undefined> = {}
      expect(await loadEnvFile(root, env)).toBe(0)
      expect(env.DEEPSEEK_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
    } finally {
      if (originalFlag === undefined) delete process.env.EASYCODE_DISABLE_GLOBAL_ENV
      else process.env.EASYCODE_DISABLE_GLOBAL_ENV = originalFlag
      await rm(root, { recursive: true, force: true })
    }
  })

  test("detects missing provider environment", () => {
    expect(needsEnvSetup(undefined, {})).toBe(true)
    expect(needsEnvSetup("fake", {})).toBe(false)
    expect(missingProviderEnv("deepseek", {})).toEqual(["DEEPSEEK_API_KEY"])
    expect(missingProviderEnv("openai", { OPENAI_API_KEY: "sk-test" })).toEqual([])
    expect(missingProviderEnv("openai-compatible", { OPENAI_COMPAT_API_KEY: "sk-test" })).toEqual(["OPENAI_COMPAT_API_URL"])
  })

  test("uses provider-specific startup model env keys", () => {
    expect(configuredStartupModel("openai", { OPENAI_MODEL: "gpt-5" })).toBe("gpt-5")
    expect(configuredStartupModel("deepseek", { DEEPSEEK_MODEL: "deepseek-chat" })).toBe("deepseek-chat")
    expect(configuredStartupModel("openai", { EASYCODE_MODEL: "fallback-only" })).toBeUndefined()
  })

  test("merges missing env values without replacing existing entries", () => {
    const merged = mergeEnvText("EASYCODE_PROVIDER=openai\nOPENAI_API_KEY=from-file\n", {
      EASYCODE_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "sk test",
      DEEPSEEK_MODEL: "deepseek-v4-pro",
    })

    expect(merged).toContain("EASYCODE_PROVIDER=openai")
    expect(merged).toContain("OPENAI_API_KEY=from-file")
    expect(merged).toContain('DEEPSEEK_API_KEY="sk test"')
    expect(merged).toContain("DEEPSEEK_MODEL=deepseek-v4-pro")
  })
})

describe("cli startup model selection", () => {
  test("lists only real startup providers", () => {
    expect(startupProviders()).toEqual(["deepseek", "openai", "openai-compatible"])
  })

  test("offers default startup model choices", () => {
    expect(startupModelChoices("deepseek")).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"])
    expect(startupModelChoices("openai")).toEqual(["gpt-5.5", "gpt-5.4"])
  })

  test("accepts preset index, preset name, and custom startup models", () => {
    expect(selectStartupModel("deepseek", "")).toBe("deepseek-v4-pro")
    expect(selectStartupModel("deepseek", "2")).toBe("deepseek-v4-flash")
    expect(selectStartupModel("openai", "gpt-5.4")).toBe("gpt-5.4")
    expect(selectStartupModel("openai", "gpt-5.5-mini")).toBe("gpt-5.5-mini")
  })

  test("keeps only the two most recent versions from live model lists", () => {
    expect(recentStartupModels("openai", ["gpt-5.4", "gpt-5", "gpt-5.5", "gpt-5.4-mini", "gpt-5.2"])).toEqual(["gpt-5.5", "gpt-5.4"])
    expect(recentStartupModels("deepseek", ["deepseek-chat", "deepseek-v4-flash", "deepseek-v3-pro", "deepseek-v4-pro"])).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"])
  })

  test("fetches startup model choices from provider model APIs", async () => {
    const models = await fetchStartupModelChoices(
      "openai",
      { OPENAI_API_KEY: "sk-test" },
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.1" }, { id: "gpt-5.5" }, { id: "gpt-5.4" }, { id: "gpt-5.5-codex" }] })),
    )
    expect(models).toEqual(["gpt-5.5", "gpt-5.4"])
  })

  test("falls back to bundled startup model choices when live fetch fails", async () => {
    const models = await fetchStartupModelChoices(
      "deepseek",
      { DEEPSEEK_API_KEY: "sk-test" },
      async () => new Response("boom", { status: 500 }),
    )
    expect(models).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"])
  })
})

describe("cli goal planning completion", () => {
  test("allows read-only review goal planning to finish with the review summary", () => {
    const goal = {
      ...createGoalState("review 当前变更"),
      status: "planning" as const,
      firstSlice: "Review the current git diff and report findings.",
      acceptanceCriteria: ["The current changes have concrete review findings."],
      completionChecks: ["Summarize correctness and regression risks."],
    }

    expect(shouldCompleteReadOnlyGoalPlanningResult(goal, "Review summary: no blocking findings.", [])).toBe(true)
  })

  test("does not complete planning summaries for mutation or verification goals", () => {
    const goal = {
      ...createGoalState("review and fix 当前变更"),
      status: "planning" as const,
      firstSlice: "Fix the failing review finding.",
      acceptanceCriteria: ["The defect is fixed."],
      completionChecks: ["Run tests."],
    }

    expect(shouldCompleteReadOnlyGoalPlanningResult(goal, "Review summary: found a defect to fix.", [])).toBe(false)
  })

  test("does not treat planning gate failures or tool failures as read-only completion", () => {
    const goal = {
      ...createGoalState("review 当前代码"),
      status: "planning" as const,
      acceptanceCriteria: ["The current code is reviewed."],
      completionChecks: ["Report findings."],
    }

    expect(shouldCompleteReadOnlyGoalPlanningResult(goal, "Planning mode hard gate failed: return a proposed plan.", [])).toBe(false)
    expect(shouldCompleteReadOnlyGoalPlanningResult(goal, "Review summary: no findings.", [
      { toolName: "git_diff", output: "denied", metadata: {}, status: "denied" },
    ])).toBe(false)
  })
})

describe("cli args", () => {
  test("interactive mode is the default when no prompt is provided", () => {
    expect(parseArgs([])).toMatchObject({ mode: "build", once: false, session: undefined, prompt: "" })
    expect(parseArgs(["build", "--provider", "fake"])).toMatchObject({ once: false, session: undefined, prompt: "" })
    expect(parseArgs(["--provider", "fake"])).toMatchObject({ mode: "build", once: false, provider: "fake", prompt: "" })
    expect(parseArgs(["hello", "--session", "demo"])).toMatchObject({ once: true, session: "demo", prompt: "hello" })
  })

  test("tui is enabled by default, --no-tui disables it", () => {
    expect(parseArgs(["build", "--provider", "fake", "--session", "demo"])).toMatchObject({ tui: true, once: false, session: "demo", prompt: "" })
    expect(parseArgs(["hello", "--provider", "fake"])).toMatchObject({ tui: true, once: true, prompt: "hello" })
    expect(parseArgs(["build", "--no-tui", "--provider", "fake", "--session", "demo"])).toMatchObject({ tui: false, once: false, session: "demo", prompt: "" })
  })

  test("session flag selects the interactive session id", () => {
    expect(parseArgs(["build", "--provider", "fake", "--session", "demo"])).toMatchObject({ once: false, session: "demo", prompt: "" })
  })

  test("startup prompts enter single-run mode, and --once remains a legacy alias", () => {
    expect(parseArgs(["hello", "--provider", "fake"])).toMatchObject({ once: true, session: undefined, prompt: "hello" })
    expect(parseArgs(["build", "--once", "hello", "--provider", "fake"])).toMatchObject({ once: true, session: undefined, prompt: "hello" })
  })

  test("context and step budgets can be set at startup", () => {
    expect(parseArgs(["hello", "--provider", "fake", "--max-tokens", "64000", "--max-steps", "24"])).toMatchObject({ maxTokens: 64_000, maxSteps: 24, prompt: "hello" })
    expect(() => parseArgs(["build", "--max-steps", "nope"])).toThrow("--max-steps requires a positive number")
  })

  test("parses --insecure and -k flags", () => {
    const originalValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    try {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      const args = parseArgs(["hello", "--provider", "fake", "--insecure"])
      expect(args.insecure).toBe(true)
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED as any).toBe("0")

      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      const argsShort = parseArgs(["hello", "--provider", "fake", "-k"])
      expect(argsShort.insecure).toBe(true)
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED as any).toBe("0")
      expect(argsShort.prompt).toBe("hello")
    } finally {
      if (originalValue === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalValue
      }
    }
  })
})
