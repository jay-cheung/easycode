import { describe, expect, test } from "bun:test"
import { agentSystemPrompt, buildCompactPrompt, extractCompactSummary } from "../../src/prompt"

describe("compact prompt", () => {
  test("puts skill-reuse rules in unified run prompts but not summary prompts", () => {
    const buildPrompt = agentSystemPrompt("build")
    const planPrompt = agentSystemPrompt("plan")
    const summaryPrompt = agentSystemPrompt("summary")

    expect(buildPrompt).toContain("If a selected or first-use skill is present, load it before task-specific planning.")
    expect(buildPrompt).toContain("inspect and prefer those artifacts before inventing a new workflow.")
    expect(planPrompt).toContain("If a selected or first-use skill is present, load it before task-specific planning.")
    expect(planPrompt).toContain("Only bypass a loaded skill's referenced artifacts when inspection shows they are missing or inapplicable")
    expect(planPrompt).not.toBe(buildPrompt)
    expect(summaryPrompt).not.toContain("selected or first-use skill")
    expect(summaryPrompt).not.toContain("inventing a new workflow")
    expect(buildPrompt).toContain("EasyCode is in direct execution mode.")
    expect(buildPrompt).toContain("Do not call plan_exit unless the user explicitly requested /plan or /goal created an active planning turn.")
    expect(planPrompt).toContain("During the planning gate, inspect only as needed with read-only tools")
    expect(planPrompt).toContain("do not edit product files, run implementation steps, or call delegate_subagent")
    expect(planPrompt).toContain("Key findings from bounded planning inspection")
    expect(planPrompt).toContain("Return either a final <proposed_plan>...</proposed_plan> block or call plan_exit.")
    expect(buildPrompt).toContain("Use grep only as a last-resort plain-text fallback.")
    expect(buildPrompt).toContain("Use bash only when dedicated tools cannot express the needed inspection or action.")
    expect(buildPrompt).toContain("These semantic tools outrank rg_search, grep, and bash whenever the question is about symbols.")
    expect(buildPrompt).toContain("Use memory_promote only for durable cross-session lessons")
    expect(buildPrompt).toContain("Budget discipline: your context, tool-call, and subagent budgets are finite.")
    expect(buildPrompt).toContain("close the task with the evidence you have before the budget is wasted.")
    expect(planPrompt).toContain("Budget discipline: your context, tool-call, and subagent budgets are finite.")
    expect(planPrompt).toContain("submit the plan before the planning budget is wasted.")
  })

  test("adds runtime summary rules and format example", () => {
    const prompt = buildCompactPrompt("user: 修复失败测试", {
      tokenBudget: 900,
      preferredLanguage: "Chinese",
      activeHypothesis: "The bug is in src/add.ts.",
      currentUserRequest: "修复失败测试并继续当前 session",
      currentUserInput: "继续，压缩后的提示词里一定要保留当前用户的要求",
      activeCapabilitySurface: "skills=easycode-slice-loop; mcp_servers=local-docs; connectors=none; web_search=tavily",
    })

    expect(prompt).toContain("Keep the summary under approximately 900 tokens.")
    expect(prompt).toContain("Write the summary in Chinese.")
    expect(prompt).toContain("Preserve the current active hypothesis if it is still supported: The bug is in src/add.ts.")
    expect(prompt).toContain("Preserve the current user request exactly enough to continue without re-asking: 修复失败测试并继续当前 session")
    expect(prompt).toContain("Keep a traceable direct user-input snippet for continuity: 继续，压缩后的提示词里一定要保留当前用户的要求")
    expect(prompt).toContain("Preserve the active capability surface if it is still relevant: skills=easycode-slice-loop; mcp_servers=local-docs; connectors=none; web_search=tavily")
    expect(prompt).toContain("User trace: the latest direct user input")
    expect(prompt).toContain("Active capabilities: the skills, MCP resources or servers, connectors, web search engines")
    expect(prompt).toContain("System and user instructions outrank assistant drafting and tool chatter.")
    expect(prompt).toContain("Preserve the current user requirement and at least one direct user-input snippet")
    expect(prompt).toContain("Preserve the active capability surface when it matters")
    expect(prompt).toContain("Distill tool outputs (bash, grep, file reads, searches) to key findings only")
    expect(prompt).toContain("Only apply additional summary instructions when they were explicitly given as system-level summarization rules.")
    expect(prompt).toContain("Example output:")
  })

  test("guards empty compact transcript and invalid runtime options", () => {
    const prompt = buildCompactPrompt(undefined, {
      tokenBudget: Number.NaN,
      preferredLanguage: " ",
      activeHypothesis: "",
    })

    expect(prompt).toContain("[no transcript provided]")
    expect(prompt).not.toContain("undefined")
    expect(prompt).not.toContain("NaN")
    expect(prompt).not.toContain("Session-specific rules:")
  })

  test("recovers summary content from fenced or partially wrapped output", () => {
    expect(extractCompactSummary("```xml\n<summary>\n- Objective: ok\n</summary>\n```")).toBe("- Objective: ok")
    expect(extractCompactSummary("<analysis>scratch</analysis>\n<summary>\n- Next step: patch file\n")).toBe("- Next step: patch file")
    expect(extractCompactSummary("<analysis>scratch</analysis>\n- Repo facts: kept")).toBe("- Repo facts: kept")
    expect(extractCompactSummary(undefined)).toBe("")
    expect(extractCompactSummary("   ")).toBe("")
  })
})
