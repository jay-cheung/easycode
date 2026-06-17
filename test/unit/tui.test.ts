import { describe, expect, test } from "bun:test"
import { displayWidth, drawCard } from "../../src/ui/tui/tui-ansi"
import { buildFailureSummaryCard, buildPanelCard } from "../../src/ui/tui/tui-cards"
import { generateStatusPanelLines } from "../../src/ui/tui/tui-status-panel"
import { TuiRenderer } from "../../src/ui/tui"
import { TuiState } from "../../src/ui/tui/tui-state"

describe("tui renderer", () => {
  test("renders session context, command bar, timeline events, and status updates", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false, columns: 88 }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
      session: "demo",
    })

    renderer.slashCommand("settings")
    renderer.panel("Settings", "provider: fake")
    renderer.event({ type: "run_start", mode: "build", provider: "fake" })
    renderer.event({ type: "text_delta", text: "Done." })
    renderer.event({ type: "run_done", status: "completed" })
    renderer.finish()

    expect(output).toContain("EasyCode TUI")
    expect(output).toContain("session=demo")
    expect(output).toContain("/help /settings /plan /goal /sessions")
    expect(output).toContain("[status] /settings")
    expect(output).toContain("[Settings]")
    expect(output).toContain("● Model")
    expect(output).toContain("● Answer")
    expect(output).toContain("Done.")
    expect(output).toContain("Execution Completed")
    expect(output).not.toContain("[status] completed")
    expect(output.indexOf("Done.")).toBeLessThan(output.indexOf("Execution Completed"))
  })

  test("shows subagent scheduling in the TUI timeline without taking over the status panel", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false, columns: 88 }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
      session: "demo",
    })

    renderer.event({ type: "run_start", mode: "build", provider: "fake" })
    renderer.event({
      type: "subagent",
      status: "scheduled",
      info: {
        id: 1,
        role: "summary",
        provider: "fake",
        model: "fake-main",
        thinking: true,
        effort: "low",
        maxProviderCalls: 1,
        maxOutputTokens: 900,
      },
    })
    renderer.event({
      type: "subagent",
      status: "completed",
      info: {
        id: 1,
        role: "summary",
        provider: "fake",
        model: "fake-main",
        thinking: true,
        effort: "low",
        maxProviderCalls: 1,
        maxOutputTokens: 900,
      },
      elapsedMs: 900,
      metrics: {
        provider: "fake",
        model: "fake-main",
        source: "subagent",
        subagentRole: "summary",
        thinking: true,
        effort: "low",
        maxOutputTokens: 900,
        maxProviderCalls: 1,
        calls: 1,
        inputTokens: 120,
        outputTokens: 40,
        cacheHitTokens: 0,
        cacheMissTokens: 120,
        totalTokens: 160,
        reasoningTokens: 10,
        hitRate: 0,
        providerElapsedMs: 900,
        firstResponseMs: 200,
        outputTokensPerSecond: 44.4,
        effectiveCost: 0,
        rates: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
      },
    })
    renderer.event({ type: "run_done", status: "completed" })
    renderer.finish()

    expect(output).toContain("Subagent scheduled id=1, role=summary")
    expect(output).toContain("Subagent #1 summary completed")
    expect(output).toContain("cache_hit=0.0%")
    expect(output).toContain("Round Subagent Detail: summary x1")
    expect(output).toContain("Round Subagent Tokens: 160 (hit 0.0%)")
    expect(output).toContain("Session Subagent Tokens: 160 (hit 0.0%) (in: 120, out: 40)")
    expect(output).not.toContain("Round Subagent Invocations")
    expect(output).not.toContain("Round Subagent Turns")
    expect(output).not.toContain("Session Subagent Turns")
    expect(output).toContain("Execution Completed")
    expect(output).not.toContain("[status] completed")
  })

  test("suppresses background timeline output while waiting at the input prompt", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false, columns: 88 }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
      session: "demo",
    })

    renderer.pauseForInputPrompt()
    renderer.event({ type: "context_compaction", status: "completed", elapsedMs: 10_000, summaryChars: 1526, summaryTokens: 613 })

    expect(output).not.toContain("Context compacted")

    renderer.resumeAfterPrompt()
    renderer.event({ type: "context_compaction", status: "completed", elapsedMs: 10_000, summaryChars: 1526, summaryTokens: 613 })

    expect(output).toContain("Context compacted")
  })

  test("renders late background subagent usage after the run summary", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false, columns: 88 }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
      session: "demo",
    })

    renderer.event({ type: "run_start", mode: "build", provider: "fake" })
    renderer.event({ type: "run_done", status: "completed" })
    renderer.pauseForInputPrompt()
    renderer.event({
      type: "subagent",
      status: "completed",
      info: {
        id: 1,
        role: "summary",
        provider: "fake",
        model: "fake-main",
        thinking: true,
        effort: "low",
        maxProviderCalls: 1,
        maxOutputTokens: 900,
      },
      elapsedMs: 900,
      metrics: {
        provider: "fake",
        model: "fake-main",
        source: "subagent",
        subagentRole: "summary",
        thinking: true,
        effort: "low",
        maxOutputTokens: 900,
        maxProviderCalls: 1,
        calls: 1,
        inputTokens: 120,
        outputTokens: 40,
        cacheHitTokens: 0,
        cacheMissTokens: 120,
        totalTokens: 160,
        reasoningTokens: 10,
        hitRate: 0,
        providerElapsedMs: 900,
        firstResponseMs: 200,
        outputTokensPerSecond: 44.4,
        effectiveCost: 0,
        rates: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
      },
    })

    expect(output).toContain("Execution Completed")
    expect(output).toContain("Subagent")
    expect(output).toContain("Round Subagent Detail: summary x1")
    expect(output).toContain("Round Subagent Tokens: 160 (hit 0.0%)")
    expect(output).not.toContain("Subagent #1 summary completed")
  })

  test("formats permission and plan approval prompts without bypassing caller input handling", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
    })

    const prompt = renderer.permissionPrompt({ id: "p1", permission: "bash", patterns: ["git status"], always: ["git status"], metadata: {} }, "Allow bash?")

    expect(prompt).toContain("[Permission]")
    expect(prompt).toContain("Allow bash?")
    expect(renderer.planApprovalPrompt()).toContain("[Plan]")
    expect(output).toContain("[status] permission: bash")
    expect(output).toContain("[status] plan approval")
  })

  test("keeps zh status panel borders aligned for tty rendering", () => {
    const lines = generateStatusPanelLines({
      context: {
        root: "/tmp/project",
        mode: "build",
        provider: "fake",
        session: "demo",
      },
      language: "zh",
      columns: 88,
      spinnerFrame: 0,
      elapsedMs: 1_250,
      statusText: "执行工具中",
    })

    const visibleWidths = lines.map((line) => displayWidth(line))
    expect(new Set(visibleWidths).size).toBe(1)
  })

  test("renders goal state in the live status panel and keeps widths aligned", () => {
    const lines = generateStatusPanelLines({
      context: {
        root: "/tmp/project",
        mode: "build",
        provider: "fake",
        session: "demo",
        goal: {
          status: "reviewing",
          objective: "Implement goal mode acceptance and review loop",
          iteration: 2,
          activePlanId: "plan_goal_mode_review",
          blocker: "Awaiting bounded verification result",
        },
      },
      language: "en",
      columns: 88,
      spinnerFrame: 0,
      elapsedMs: 1_250,
      statusText: "Reviewing goal slice",
    })

    expect(lines.join("\n")).toContain("Goal: reviewing")
    expect(lines.join("\n")).toContain("iter: 2")
    expect(lines.join("\n")).toContain("plan_goal_mode_review")
    expect(lines.join("\n")).toContain("Objective: Implement goal mode acceptance and review loop")
    expect(lines.join("\n")).toContain("blocker: Awaiting")
    const visibleWidths = lines.map((line) => displayWidth(line))
    expect(new Set(visibleWidths).size).toBe(1)
  })

  test("keeps zh card headers aligned for tty rendering", () => {
    const card = drawCard("实时状态", ["第一行", "第二行"], 88, { borderStyle: "round" })
    const visibleWidths = card.split("\n").map((line) => displayWidth(line))
    expect(new Set(visibleWidths).size).toBe(1)
  })

  test("keeps permission card borders aligned with emoji titles and truncated body", () => {
    const card = buildPanelCard("🛡️ 权限确认", "Allow bash for curl -s \"http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_StocksService.getKLineData\"", 88)
    const visibleWidths = card.split("\n").map((line) => displayWidth(line))
    expect(new Set(visibleWidths).size).toBe(1)
  })

  test("wraps failure reasons instead of truncating follow-up guidance", () => {
    const card = buildFailureSummaryCard(
      "en",
      1,
      { provider: "fake", model: "fake", calls: 66, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, reasoningTokens: 0, hitRate: 0, providerElapsedMs: 1, firstResponseMs: 1, outputTokensPerSecond: 0, effectiveCost: 0, rates: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 } },
      { inputTokens: 0, outputTokens: 0, calls: 0, invocations: 0, cacheHitTokens: 0, cacheMissTokens: 0, roleCounts: {} },
      { inputTokens: 0, outputTokens: 0, calls: 0, subagentInputTokens: 0, subagentOutputTokens: 0, subagentCalls: 0, subagentCacheHitTokens: 0, subagentCacheMissTokens: 0 },
      "Stopped after maxSteps (66).\nContinue with another message to keep going.",
      72,
    )

    expect(card).toContain("Continue with another message to keep going.")
    expect(card).not.toContain("Continue with another me...")
    const visibleWidths = card.split("\n").map((line) => displayWidth(line))
    expect(new Set(visibleWidths).size).toBe(1)
  })

  test("tracks panel elapsed per phase instead of across the whole run", () => {
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now

    try {
      const state = new TuiState()
      state.beginRun("初始化中")

      now = 5_000
      state.tickSpinner(10)
      expect(state.runElapsedMs).toBe(4_000)
      expect(state.phaseElapsedMs).toBe(4_000)

      state.setStatus("等待 deepseek 响应...", "provider:deepseek:deepseek-v4-flash")
      now = 9_000
      state.tickSpinner(10)
      expect(state.runElapsedMs).toBe(8_000)
      expect(state.phaseElapsedMs).toBe(4_000)

      state.setStatus("等待 deepseek 响应...", "provider:deepseek:deepseek-v4-flash")
      now = 11_000
      state.tickSpinner(10)
      expect(state.phaseElapsedMs).toBe(6_000)

      state.setStatus("运行工具：bash（3s）", "tool:call_1:progress")
      now = 14_000
      state.tickSpinner(10)
      expect(state.runElapsedMs).toBe(13_000)
      expect(state.phaseElapsedMs).toBe(3_000)
    } finally {
      Date.now = originalNow
    }
  })

  test("resets phase elapsed timer on consecutive provider calls via unique phase keys", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
    })

    renderer.event({ type: "run_start", mode: "build", provider: "fake" })
    
    // First provider call start
    renderer.event({ type: "provider_progress", provider: "fake", model: "deepseek", elapsedMs: 0 })
    const state = (renderer as any).state
    const firstKey = state.phaseKey
    expect(firstKey).toBe("provider:fake:deepseek:1")

    // Second provider call start (elapsedMs = 0)
    renderer.event({ type: "provider_progress", provider: "fake", model: "deepseek", elapsedMs: 0 })
    const secondKey = state.phaseKey
    expect(secondKey).toBe("provider:fake:deepseek:2")
    expect(secondKey).not.toBe(firstKey)
  })

  test("renders goal lifecycle events in the timeline", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false, columns: 88 }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
      session: "demo",
    })

    renderer.event({
      type: "goal",
      phase: "planning",
      goal: {
        status: "planning",
        objective: "Implement goal mode",
        iteration: 1,
        activePlanId: "none",
      },
    })
    renderer.event({
      type: "goal",
      phase: "cleared",
      goal: {
        status: "completed",
        objective: "Implement goal mode",
        iteration: 1,
      },
    })
    renderer.finish()

    expect(output).toContain("Goal planning status=planning")
    expect(output).toContain("\"Implement goal mode\"")
    expect(output).toContain("Goal cleared status=completed")
  })
})
