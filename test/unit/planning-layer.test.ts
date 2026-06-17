import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ContextManager } from "../../src/context"
import { InvalidExecutionPlanError, loadStructuredPlan, loadStructuredPlanState, isComplexPlan, renderPlanToMarkdown } from "../../src/plans"
import { parseExecutionPlanFromResponse, Planner, Replanner, PlanTracker } from "../../src/agent/planner"
import type { Provider, ProviderEvent } from "../../src/provider/types"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-plan-test-"))
}

const mockProvider: Provider = {
  name: "mock-llm",
  capabilities: {
    apiStyle: "local" as const,
    supportsImages: false,
    supportsThinking: false,
    supportsReasoningEffort: false,
    effortValues: [],
    supportsJsonObjectResponse: false,
    supportsMaxOutputTokens: false,
    promptCacheMode: "none" as const,
  },
  async *stream(input): AsyncGenerator<ProviderEvent, void, unknown> {
    if (input.prompt.includes("Markdown Plan:")) {
      yield {
        type: "text_delta" as const,
        text: `\`\`\`json
{
  "id": "plan_12345",
  "title": "Mock Plan",
  "steps": [
    {
      "id": "step_1",
      "goal": "Inspect code",
      "kind": "inspect",
      "doneWhen": "Inspect completed"
    },
    {
      "id": "step_2",
      "goal": "Edit code",
      "kind": "edit",
      "doneWhen": "Edit completed"
    }
  ]
}
\`\`\``
      }
    } else if (input.prompt.includes("Replan request.")) {
      yield {
        type: "text_delta" as const,
        text: `\`\`\`json
{
  "id": "plan_12345",
  "title": "Mock Replan",
  "steps": [
    {
      "id": "step_1",
      "goal": "Inspect code",
      "kind": "inspect",
      "doneWhen": "Inspect completed"
    },
    {
      "id": "step_2",
      "goal": "Edit code revised",
      "kind": "edit",
      "doneWhen": "Edit revised completed"
    }
  ]
}
\`\`\``
      }
    }
  }
}

describe("Planning Layer & Executable Plans", () => {
  test("isComplexPlan correctly detects if plan contains edit steps", () => {
    const complexPlan = {
      id: "plan_1",
      lowRisk: false,
      steps: [
        { id: "step_1", goal: "inspect files", kind: "inspect" as const },
        { id: "step_2", goal: "change constant", kind: "edit" as const }
      ]
    }
    const simplePlan = {
      id: "plan_2",
      lowRisk: true,
      steps: [
        { id: "step_1", goal: "inspect files", kind: "inspect" as const },
        { id: "step_2", goal: "verify output", kind: "verify" as const }
      ]
    }
    expect(isComplexPlan(complexPlan)).toBe(true)
    expect(isComplexPlan(simplePlan)).toBe(false)
  })

  test("Planner converts markdown plan to structured ExecutionPlan JSON", async () => {
    const plan = await Planner.generateStructuredPlan("Implement task", "Markdown description here", mockProvider)
    expect(plan.id).toBe("plan_12345")
    expect(plan.title).toBe("Mock Plan")
    expect(plan.steps.length).toBe(2)
    expect(plan.steps[0].id).toBe("step_1")
    expect(plan.steps[1].kind).toBe("edit")
  })

  test("normalizeExecutionPlan infers subagent metadata from delegation-oriented steps", () => {
    const plan = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_delegate",
      steps: [
        {
          id: "step_1",
          goal: "Delegate explorer to inspect src/add.ts and capture the current behavior",
          kind: "inspect",
          doneWhen: "The explorer has identified the exported function and incorrect operator.",
        },
      ],
    }))

    expect(plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "explorer", delegationPolicy: "required" })
  })

  test("normalizeExecutionPlan infers preferred delegation when fallback allows coordinator recovery", () => {
    const plan = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_preferred_delegate",
      steps: [
        {
          id: "step_1",
          goal: "Delegate explorer to inspect src/add.ts and capture the current behavior",
          kind: "inspect",
          doneWhen: "The explorer has identified the exported function and incorrect operator.",
          fallback: "If explorer fails, manually inspect the source file and continue with available information.",
        },
      ],
    }))

    expect(plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "explorer", delegationPolicy: "preferred" })
  })

  test("normalizeExecutionPlan drops subagent role metadata when executorHint is explicitly main", () => {
    const plan = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_main_review",
      steps: [
        {
          id: "step_1",
          goal: "Review subagent outputs and write the final synthesis",
          kind: "inspect",
          executorHint: "main",
          subagentRole: "reviewer",
          delegationPolicy: "preferred",
          doneWhen: "The coordinator has produced the final synthesis.",
        },
      ],
    }))

    expect(plan.steps[0].executorHint).toBe("main")
    expect(plan.steps[0].subagentRole).toBeUndefined()
    expect(plan.steps[0].delegationPolicy).toBeUndefined()
  })

  test("normalizeExecutionPlan routes skill script inspection to explorer even without explicit delegation text", () => {
    const plan = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_skill_script_inspect",
      steps: [
        {
          id: "step_1",
          goal: "查脚本并确认当前 skill 实际使用哪个脚本入口",
          kind: "inspect",
          doneWhen: "The script path and entry file are identified.",
        },
      ],
    }))

    expect(plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "explorer" })
  })

  test("normalizeExecutionPlan routes skill script failure diagnosis to debugger", () => {
    const plan = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_skill_script_debug",
      steps: [
        {
          id: "step_1",
          goal: "Diagnose why the skill script fails with module not found and capture the script logs",
          kind: "inspect",
          doneWhen: "The failure cause is reproduced with bounded evidence.",
        },
      ],
    }))

    expect(plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "debugger" })
  })

  test("normalizeExecutionPlan conservatively infers missing lowRisk", () => {
    const readonlyPlan = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_readonly",
      steps: [
        { id: "step_1", goal: "Inspect src/add.ts and report current behavior", kind: "inspect" },
      ],
    }))
    const editPlan = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_edit",
      steps: [
        { id: "step_1", goal: "Edit src/add.ts", kind: "edit" },
      ],
    }))
    const explicitFalse = parseExecutionPlanFromResponse(JSON.stringify({
      id: "plan_explicit",
      lowRisk: false,
      steps: [
        { id: "step_1", goal: "Inspect src/add.ts", kind: "inspect" },
      ],
    }))

    expect(readonlyPlan.lowRisk).toBe(true)
    expect(editPlan.lowRisk).toBe(false)
    expect(explicitFalse.lowRisk).toBe(false)
  })

  test("renderPlanToMarkdown makes lowRisk visible and preserves it in JSON", () => {
    const markdown = renderPlanToMarkdown({
      id: "plan_visible_lowrisk",
      title: "Visible low risk",
      lowRisk: true,
      steps: [
        {
          id: "step_1",
          goal: "Inspect src/add.ts",
          kind: "inspect",
          executorHint: "subagent",
          subagentRole: "explorer",
          delegationPolicy: "preferred",
        },
      ],
    })

    expect(markdown).toContain("- **Low Risk**: true")
    expect(markdown).toContain('"lowRisk": true')
    expect(markdown).not.toContain("executorHint")
    expect(markdown).not.toContain("subagentRole")
    expect(markdown).not.toContain("delegationPolicy")
  })

  test("Replanner rewrites remaining steps of plan", async () => {
    const currentPlan = {
      id: "plan_12345",
      title: "Mock Plan",
      lowRisk: false,
      steps: [
        { id: "step_1", goal: "Inspect code", kind: "inspect" as const },
        { id: "step_2", goal: "Edit code", kind: "edit" as const }
      ]
    }
    const stepStatuses = { step_1: "completed" as const, step_2: "failed" as const }
    
    const plan = await Replanner.replan("Implement task", currentPlan, stepStatuses, "step_2", "Tool returned non-zero exit code", mockProvider)
    expect(plan.id).toBe("plan_12345")
    expect(plan.title).toBe("Mock Replan")
    expect(plan.steps.length).toBe(2)
    expect(plan.steps[1].goal).toBe("Edit code revised")
  })

  test("Planner fails closed when structured response is invalid", () => {
    expect(() => parseExecutionPlanFromResponse("not-json")).toThrow(InvalidExecutionPlanError)
  })

  test("normalizeExecutionPlan detects non-existent step dependencies", () => {
    const invalidPlan = {
      id: "plan_invalid_dep",
      steps: [
        { id: "step_1", goal: "inspect", kind: "inspect" as const, dependsOn: ["non_existent_step"] }
      ]
    }
    expect(() => parseExecutionPlanFromResponse(JSON.stringify(invalidPlan))).toThrow(InvalidExecutionPlanError)
  })

  test("normalizeExecutionPlan detects circular dependencies", () => {
    const cyclicPlan = {
      id: "plan_cyclic",
      steps: [
        { id: "step_1", goal: "inspect", kind: "inspect" as const, dependsOn: ["step_2"] },
        { id: "step_2", goal: "edit", kind: "edit" as const, dependsOn: ["step_1"] }
      ]
    }
    expect(() => parseExecutionPlanFromResponse(JSON.stringify(cyclicPlan))).toThrow(InvalidExecutionPlanError)
  })

  test("PlanTracker updates step statuses in ledger and checkpoints to memory", async () => {
    const root = await tmpdir()
    try {
      const context = new ContextManager()
      const plan = {
        id: "plan_tracker_test",
        title: "Tracker Test",
        lowRisk: true,
        steps: [
          { id: "step_1", goal: "Goal 1", kind: "inspect" as const }
        ]
      }
      const stepStatuses = { step_1: "running" as const }
      
      await PlanTracker.updateStepStatus(context, root, "test-session", plan, stepStatuses, "step_1", "running")
      
      const ledger = context.state.ledger?.current ?? []
      expect(ledger).toContainEqual(expect.objectContaining({ subject: "current_plan_id", value: "plan_tracker_test" }))
      expect(ledger).toContainEqual(expect.objectContaining({ subject: "current_plan_step", value: "step_1" }))
      expect(ledger).toContainEqual(expect.objectContaining({ subject: "plan_step_status", value: "running" }))

      // Check loaded plan
      const loaded = await loadStructuredPlan(root, "test-session", "plan_tracker_test")
      expect(loaded).toBeDefined()
      expect(loaded?.id).toBe("plan_tracker_test")
      const state = await loadStructuredPlanState(root, "test-session", "plan_tracker_test")
      expect(state?.checkpoint.currentStepId).toBe("step_1")
      expect(state?.checkpoint.stepStatuses.step_1).toBe("running")
      expect(state?.checkpoint.status).toBe("running")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PlanTracker clearActivePlan archives plan state", async () => {
    const root = await tmpdir()
    try {
      const context = new ContextManager()
      const plan = {
        id: "plan_tracker_test",
        title: "Tracker Test",
        lowRisk: true,
        steps: [
          { id: "step_1", goal: "Goal 1", kind: "inspect" as const }
        ]
      }
      const stepStatuses = { step_1: "completed" as const }
      
      await PlanTracker.updateStepStatus(context, root, "test-session", plan, stepStatuses, "step_1", "completed")
      await PlanTracker.clearActivePlan(context, root, "plan_tracker_test")
      
      const ledgerCurrent = context.state.ledger?.current ?? []
      expect(ledgerCurrent.some(r => r.subject === "current_plan_id")).toBe(false)
      
      const ledgerHistory = context.state.ledger?.history ?? []
      expect(ledgerHistory).toContainEqual(expect.objectContaining({ subject: "current_plan_id", value: "plan_tracker_test", status: "resolved" }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
