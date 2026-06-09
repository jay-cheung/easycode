import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentRunner } from "../../src/agent"
import { createBuiltinRegistry } from "../../src/tool"
import { PermissionService, defaultPermissionRules } from "../../src/permission"
import { ContextManager } from "../../src/context"
import { saveStructuredPlan, loadStructuredPlan, isComplexPlan } from "../../src/plans"
import { Planner, Replanner, PlanTracker } from "../../src/agent/planner"
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
  async *stream(input: any): AsyncGenerator<ProviderEvent, void, unknown> {
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
      steps: [
        { id: "step_1", goal: "inspect files", kind: "inspect" as const },
        { id: "step_2", goal: "change constant", kind: "edit" as const }
      ]
    }
    const simplePlan = {
      id: "plan_2",
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

  test("Replanner rewrites remaining steps of plan", async () => {
    const currentPlan = {
      id: "plan_12345",
      title: "Mock Plan",
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

  test("PlanTracker updates step statuses in ledger and checkpoints to memory", async () => {
    const root = await tmpdir()
    try {
      const context = new ContextManager()
      const plan = {
        id: "plan_tracker_test",
        title: "Tracker Test",
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
