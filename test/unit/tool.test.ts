import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { createBuiltinRegistry, ToolRegistry } from "../../src/tool"
import { ContextManager } from "../../src/context"
import { SandboxPathEscapeError, type BashResult, Sandbox } from "../../src/sandbox"
import { PermissionService, defaultPermissionAutoReviewer, defaultPermissionRules } from "../../src/permission"
import { SkillService } from "../../src/skill"
import { toolCallMessage, toolResultMessage, userMessage, type Message } from "../../src/message"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

delete process.env.TAVILY_API_KEY

const tempRoots: string[] = []

async function tmpdir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "easycode-tool-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe("tool", () => {
  test("detects registration conflicts", () => {
    const registry = new ToolRegistry()
    const read = createBuiltinRegistry().get("read")
    if (!read) throw new Error("missing read")
    registry.register(read)
    expect(() => registry.register(read)).toThrow("Tool already registered")
  })

  test("keeps the legacy plan registry readonly while exposing plan_exit in unified runs", () => {
    const registry = createBuiltinRegistry()
    expect(registry.list("plan").some((tool) => tool.name === "edit")).toBe(false)
    expect(registry.list("build").some((tool) => tool.name === "edit")).toBe(true)
    expect(registry.list("plan").some((tool) => tool.name === "plan_exit")).toBe(true)
    expect(registry.list("build").some((tool) => tool.name === "plan_exit")).toBe(true)
  })

  test("goal tools update transient goal ledger state", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const context = new ContextManager()
    context.setLedger({
      current: [
        {
          id: "goal_id",
          kind: "checkpoint",
          subject: "current_goal_id",
          value: "goal_123",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_objective",
          kind: "checkpoint",
          subject: "current_goal_objective",
          value: "Implement goal mode",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_status",
          kind: "checkpoint",
          subject: "current_goal_status",
          value: "executing",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_iteration",
          kind: "checkpoint",
          subject: "current_goal_iteration",
          value: "2",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_acceptance",
          kind: "checkpoint",
          subject: "current_goal_acceptance_criteria",
          value: "- The code path is correct",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_checks",
          kind: "checkpoint",
          subject: "current_goal_completion_checks",
          value: "- Run focused verification",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_blocker",
          kind: "checkpoint",
          subject: "current_goal_blocker",
          value: "none",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
      ],
    })

    const blocked = await registry.run("goal_blocked", { reason: "Awaiting user approval" }, { ...toolContext(root), context })
    expect(blocked.metadata.status).toBe("succeeded")
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "blocked" }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_blocker", value: "Awaiting user approval" }))

    const completed = await registry.run("goal_complete", { summary: "Done" }, { ...toolContext(root), context })
    expect(completed.metadata.status).toBe("succeeded")
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "completed" }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_blocker", value: "none" }))
  })

  test("goal_set_acceptance records acceptance criteria and completion checks", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const context = new ContextManager()
    context.setLedger({
      current: [
        {
          id: "goal_id",
          kind: "checkpoint",
          subject: "current_goal_id",
          value: "goal_456",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_objective",
          kind: "checkpoint",
          subject: "current_goal_objective",
          value: "Ship goal review loop",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_status",
          kind: "checkpoint",
          subject: "current_goal_status",
          value: "defining",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_iteration",
          kind: "checkpoint",
          subject: "current_goal_iteration",
          value: "1",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_blocker",
          kind: "checkpoint",
          subject: "current_goal_blocker",
          value: "none",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
      ],
    })

    const result = await registry.run("goal_set_acceptance", {
      acceptanceCriteria: ["All named acceptance criteria are satisfied"],
      completionChecks: ["Run focused verification", "Review for remaining defects"],
    }, { ...toolContext(root), context })

    expect(result.metadata.status).toBe("succeeded")
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "planning" }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_acceptance_criteria", value: expect.stringContaining("All named acceptance criteria are satisfied") }))
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_completion_checks", value: expect.stringContaining("Review for remaining defects") }))
  })

  test("goal_set_acceptance fails outside the defining phase", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const context = new ContextManager()
    context.setLedger({
      current: [
        {
          id: "goal_id",
          kind: "checkpoint",
          subject: "current_goal_id",
          value: "goal_457",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_objective",
          kind: "checkpoint",
          subject: "current_goal_objective",
          value: "Ship goal review loop",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_status",
          kind: "checkpoint",
          subject: "current_goal_status",
          value: "planning",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_iteration",
          kind: "checkpoint",
          subject: "current_goal_iteration",
          value: "1",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
      ],
    })

    const result = await registry.run("goal_set_acceptance", {
      acceptanceCriteria: ["All named acceptance criteria are satisfied"],
      completionChecks: ["Run focused verification"],
    }, { ...toolContext(root), context })

    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("goal_acceptance_wrong_phase")
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "planning" }))
    expect(context.state.ledger?.current?.some((record) => record.subject === "current_goal_acceptance_criteria")).toBe(false)
  })

  test("goal_complete fails if acceptance criteria were never recorded", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const context = new ContextManager()
    context.setLedger({
      current: [
        {
          id: "goal_id",
          kind: "checkpoint",
          subject: "current_goal_id",
          value: "goal_789",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_objective",
          kind: "checkpoint",
          subject: "current_goal_objective",
          value: "Finish the feature",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_status",
          kind: "checkpoint",
          subject: "current_goal_status",
          value: "reviewing",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_iteration",
          kind: "checkpoint",
          subject: "current_goal_iteration",
          value: "2",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_blocker",
          kind: "checkpoint",
          subject: "current_goal_blocker",
          value: "none",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
      ],
    })

    const result = await registry.run("goal_complete", { summary: "done" }, { ...toolContext(root), context })
    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("goal_acceptance_missing")
  })

  test("goal_complete fails while a plan slice is still active", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const context = new ContextManager()
    context.setLedger({
      current: [
        {
          id: "goal_id",
          kind: "checkpoint",
          subject: "current_goal_id",
          value: "goal_790",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_objective",
          kind: "checkpoint",
          subject: "current_goal_objective",
          value: "Finish the feature",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_status",
          kind: "checkpoint",
          subject: "current_goal_status",
          value: "executing",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_iteration",
          kind: "checkpoint",
          subject: "current_goal_iteration",
          value: "2",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_acceptance",
          kind: "checkpoint",
          subject: "current_goal_acceptance_criteria",
          value: "- Finish the feature safely",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_checks",
          kind: "checkpoint",
          subject: "current_goal_completion_checks",
          value: "- Run focused verification",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "plan_id",
          kind: "checkpoint",
          subject: "current_plan_id",
          value: "plan_active",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
      ],
    })

    const result = await registry.run("goal_complete", { summary: "done" }, { ...toolContext(root), context })
    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("goal_review_required")
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "executing" }))
  })

  test("goal_complete fails in review when the latest findings still report blockers", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const context = new ContextManager()
    context.setLedger({
      current: [
        {
          id: "goal_id",
          kind: "checkpoint",
          subject: "current_goal_id",
          value: "goal_791",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_objective",
          kind: "checkpoint",
          subject: "current_goal_objective",
          value: "Review current changes",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_status",
          kind: "checkpoint",
          subject: "current_goal_status",
          value: "reviewing",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_iteration",
          kind: "checkpoint",
          subject: "current_goal_iteration",
          value: "2",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_acceptance",
          kind: "checkpoint",
          subject: "current_goal_acceptance_criteria",
          value: "- Review all modified files",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_checks",
          kind: "checkpoint",
          subject: "current_goal_completion_checks",
          value: "- Replan if review finds blocking defects",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
        {
          id: "goal_blocker",
          kind: "checkpoint",
          subject: "current_goal_blocker",
          value: "none",
          status: "current",
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
      ],
    })
    context.add(toolCallMessage([
      {
        id: "call_goal_complete",
        name: "goal_complete",
        input: { summary: "NOT COMMITTABLE. Blockers C1+C2 must be fixed before commit." },
      },
    ], "", "Final verdict: NOT COMMITTABLE. Blockers C1+C2 must be fixed before commit."))

    const result = await registry.run("goal_complete", { summary: "NOT COMMITTABLE. Blockers C1+C2 must be fixed before commit." }, { ...toolContext(root), context })

    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("goal_review_blocking_findings")
    expect(context.state.ledger?.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "reviewing" }))
  })

  test("ledger tool pulls structured context only when called", async () => {
    const registry = createBuiltinRegistry()
    const context = new ContextManager()
    context.setLedger({
      current: [
        {
          id: "intent:current_user_request",
          kind: "intent",
          subject: "current_user_request",
          value: "continue the APIx evaluation",
          status: "current",
          evidence: { source: "user", messageIndex: 0 },
          createdAtTurn: 0,
          updatedAtTurn: 0,
        },
      ],
    })

    const result = await registry.run("ledger", { query: "confirm progress" }, { ...toolContext(), context })

    expect(result.metadata.status).toBe("succeeded")
    expect(result.metadata.empty).toBe(false)
    expect(result.output).toContain("<context_state_ledger>")
    expect(result.output).toContain("continue the APIx evaluation")
  })

  test("accepts null for optional model arguments", async () => {
    const registry = createBuiltinRegistry()
    const root = import.meta.dir
    const result = await registry.run("list", { dirPath: null }, { agentMode: "build", sandbox: new Sandbox(root), permission: PermissionService.autoApprove(defaultPermissionRules("build")), skills: new SkillService(root), messages: [] })
    expect(result.metadata.status).toBe("succeeded")
  })

  test("skill tool surfaces referenced local artifacts before skill content", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "skills", "demo", "scripts"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "skills", "demo", "scripts", "bootstrap.sh"), "#!/usr/bin/env bash\n")
    await Bun.write(
      path.join(root, ".easycode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\nUse `scripts/bootstrap.sh` first.\nThen continue.\n",
    )

    const result = await registry.run("skill", { name: "demo" }, toolContext(root))

    expect(result.metadata.status).toBe("succeeded")
    expect(result.output).toContain("<skill_artifacts>")
    expect(result.output).toContain("- file: scripts/bootstrap.sh")
    expect(result.output).toContain("Then continue.")
    expect(result.metadata.artifactCount).toBe(1)
  })

  test("returns provider argument parse errors as tool result feedback", async () => {
    const registry = createBuiltinRegistry()
    const root = import.meta.dir
    const result = await registry.run(
      "list",
      {
        __easycodeInvalidToolArguments: true,
        code: "invalid_tool_arguments",
        message: "Invalid tool arguments from provider for list: JSON Parse error",
        tool: "list",
        callID: "call_1",
        arguments: "{\"dirPath\": .}",
      },
      { agentMode: "build", sandbox: new Sandbox(root), permission: PermissionService.autoApprove(defaultPermissionRules("build")), skills: new SkillService(root), messages: [] },
    )
    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("invalid_tool_arguments")
    expect(result.output).toContain("Invalid tool arguments from provider for list")
    expect(result.output).toContain("{\"dirPath\": .}")
  })

  test("wraps tool pattern errors as failed tool results", async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: "broken_patterns",
      description: "Broken pattern tool",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      permission: "read",
      modes: ["build"],
      patterns: () => {
        throw new Error("pattern failed")
      },
      execute: async () => ({ title: "unreachable", output: "", metadata: { status: "succeeded" } }),
    })
    const result = await registry.run("broken_patterns", {}, toolContext())
    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("Error")
    expect(result.output).toBe("pattern failed")
  })

  test("wraps tool execution errors as failed tool results", async () => {
    const registry = createBuiltinRegistry()
    const result = await registry.run("read", { filePath: "missing-file.txt" }, toolContext())
    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("Error")
    expect(result.output).toContain("missing-file.txt")
  })

  test("describes edit replaceAll behavior in schema", () => {
    const edit = createBuiltinRegistry().get("edit")
    expect(edit?.description).toContain("only the first match")
    expect(edit?.jsonSchema.properties.replaceAll.description).toContain("replace every match")
  })

  test("describes semantic navigation and bash fallback boundaries clearly", () => {
    const registry = createBuiltinRegistry()
    expect(registry.get("repo_map")?.description).toContain("First-choice code exploration entrypoint")
    expect(registry.get("find_definition")?.description).toContain("Primary semantic definition lookup")
    expect(registry.get("find_references")?.description).toContain("Primary semantic reference lookup")
    expect(registry.get("call_graph")?.description).toContain("Primary caller/callee exploration tool")
    expect(registry.get("rg_search")?.description).toContain("Prefer this over grep")
    expect(registry.get("grep")?.description).toContain("Last-resort plain text search")
    expect(registry.get("bash")?.description).toContain("Last-resort shell command execution")
    expect(registry.get("bash")?.description).toContain("prefer repo_map, find_definition, find_references, call_graph, rg_search, read_lines, and git_* tools first")
    expect(registry.get("memory_promote")?.description).toContain("durable cross-session lesson")
  })

  test("registers semantic navigation and diff tools in plan and build mode", () => {
    const registry = createBuiltinRegistry()
    for (const name of ["rg_search", "read_lines", "find_definition", "find_references", "call_graph", "repo_map", "git_diff", "git_status", "git_branch", "git_log"]) {
      expect(registry.list("plan").some((tool) => tool.name === name)).toBe(true)
      expect(registry.list("build").some((tool) => tool.name === name)).toBe(true)
    }
    for (const name of ["patch", "git_stage", "git_commit", "git_restore_guarded", "memory_add", "memory_promote", "connector_call"]) {
      expect(registry.list("plan").some((tool) => tool.name === name)).toBe(false)
      expect(registry.list("build").some((tool) => tool.name === name)).toBe(true)
    }
  })

  test("read_lines returns only the requested file slice", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await Bun.write(path.join(root, "sample.ts"), "one\ntwo\nthree\n")

    const result = await registry.run("read_lines", { filePath: "sample.ts", startLine: 2, endLine: 2 }, toolContext(root))

    expect(result.metadata.status).toBe("succeeded")
    expect(result.title).toBe("sample.ts:2-2")
    expect(result.output).toBe("2 | two")
  })

  test("blocks exact duplicate read on the same file", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await Bun.write(path.join(root, "sample.ts"), "one\ntwo\n")
    const messages = [
      userMessage("Inspect sample.ts"),
      toolCallMessage({ id: "call_read_1", name: "read", input: { filePath: "sample.ts" } }),
      toolResultMessage({ callID: "call_read_1", toolName: "read", status: "succeeded", output: "one\ntwo\n", metadata: { status: "succeeded" } }),
    ]

    const result = await registry.run("read", { filePath: "sample.ts" }, toolContext(root, messages))

    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("duplicate_inspection")
    expect(result.output).toContain("read sample.ts")
  })

  test("allows read_lines on the same file when the requested range differs", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await Bun.write(path.join(root, "sample.ts"), "one\ntwo\nthree\n")
    const messages = [
      userMessage("Inspect sample.ts"),
      toolCallMessage({ id: "call_read_lines_1", name: "read_lines", input: { filePath: "sample.ts", startLine: 1, endLine: 1 } }),
      toolResultMessage({ callID: "call_read_lines_1", toolName: "read_lines", status: "succeeded", output: "1 | one", metadata: { status: "succeeded" } }),
    ]

    const result = await registry.run("read_lines", { filePath: "sample.ts", startLine: 2, endLine: 2 }, toolContext(root, messages))

    expect(result.metadata.status).toBe("succeeded")
    expect(result.output).toBe("2 | two")
  })

  test("allows reread after a successful edit invalidates prior inspection", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await Bun.write(path.join(root, "sample.ts"), "one\ntwo\n")
    const messages = [
      userMessage("Inspect and fix sample.ts"),
      toolCallMessage({ id: "call_read_1", name: "read", input: { filePath: "sample.ts" } }),
      toolResultMessage({ callID: "call_read_1", toolName: "read", status: "succeeded", output: "one\ntwo\n", metadata: { status: "succeeded" } }),
      toolCallMessage({ id: "call_edit_1", name: "edit", input: { filePath: "sample.ts", oldString: "one", newString: "ONE" } }),
      toolResultMessage({ callID: "call_edit_1", toolName: "edit", status: "succeeded", output: "updated", metadata: { status: "succeeded" } }),
    ]

    const result = await registry.run("read", { filePath: "sample.ts" }, toolContext(root, messages))

    expect(result.metadata.status).toBe("succeeded")
    expect(result.output).toContain("one")
  })

  test("blocks exact duplicate git_status inspection", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await git(root, ["init"])
    const messages = [
      userMessage("Check git state"),
      toolCallMessage({ id: "call_git_status_1", name: "git_status", input: { short: true } }),
      toolResultMessage({ callID: "call_git_status_1", toolName: "git_status", status: "succeeded", output: "clean", metadata: { status: "succeeded" } }),
    ]

    const result = await registry.run("git_status", { short: true }, toolContext(root, messages))

    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("duplicate_inspection")
    expect(result.output).toContain("git_status")
  })

  test("read blocks large files and points to semantic navigation", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await Bun.write(path.join(root, "large.ts"), Array.from({ length: 101 }, (_, index) => `export const v${index} = ${index}`).join("\n"))

    const result = await registry.run("read", { filePath: "large.ts" }, toolContext(root))

    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("large_file_read_forbidden")
    expect(result.output).toContain("Use repo_map")
    expect(result.output).toContain("read_lines")
  })

  test("repo_map writes a derived ignored cache without changing source files", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "sample.ts"), "export function sample() {\n  return 1\n}\n")

    const result = await registry.run("repo_map", { dir: "src", language: "typescript" }, toolContext(root))

    expect(result.metadata.status).toBe("succeeded")
    expect(result.metadata.cachePath).toBe(".easycode/cache/repo-map.json")
    expect(result.output).toContain("function sample")
    expect(await Bun.file(path.join(root, ".easycode", "cache", "repo-map.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "src", "sample.ts")).text()).toContain("return 1")
  })

  test("git_diff reports scoped changes without full bash diff", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await git(root, ["init"])
    await git(root, ["config", "user.email", "easycode@example.test"])
    await git(root, ["config", "user.name", "EasyCode Test"])
    await Bun.write(path.join(root, "sample.ts"), "export const value = 1\n")
    await git(root, ["add", "sample.ts"])
    await Bun.write(path.join(root, "sample.ts"), "export const value = 2\n")

    const files = await registry.run("git_diff", { mode: "files" }, toolContext(root))
    const patch = await registry.run("git_diff", { mode: "file", filePath: "sample.ts", maxBytes: 1000 }, toolContext(root))

    expect(files.metadata.status).toBe("succeeded")
    expect(files.output.trim()).toBe("sample.ts")
    expect(patch.output).toContain("-export const value = 1")
    expect(patch.output).toContain("+export const value = 2")
  })

  test("edit replaces first match by default and all matches when requested", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await Bun.write(path.join(root, "sample.txt"), "one one one")
    const ctx = toolContext(root)

    await registry.run("edit", { filePath: "sample.txt", oldString: "one", newString: "two" }, ctx)
    expect(await Bun.file(path.join(root, "sample.txt")).text()).toBe("two one one")

    await registry.run("edit", { filePath: "sample.txt", oldString: "one", newString: "two", replaceAll: true }, ctx)
    expect(await Bun.file(path.join(root, "sample.txt")).text()).toBe("two two two")
  })

  test("patch applies multiple explicit file operations", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "sample.txt"), "alpha beta beta")
    const ctx = toolContext(root)

    const result = await registry.run(
      "patch",
      {
        operations: [
          { type: "replace", filePath: "src/sample.txt", oldString: "beta", newString: "gamma", replaceAll: true },
          { type: "create", filePath: "src/new.txt", content: "new file\n" },
          { type: "move", fromPath: "src/new.txt", toPath: "src/moved.txt" },
        ],
      },
      ctx,
    )

    expect(result.metadata.status).toBe("succeeded")
    expect(await Bun.file(path.join(root, "src", "sample.txt")).text()).toBe("alpha gamma gamma")
    expect(await Bun.file(path.join(root, "src", "moved.txt")).text()).toBe("new file\n")
  })

  test("memory tools store sanitized short project records", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const ctx = toolContext(root)

    const added = await registry.run("memory_add", { text: "OPENAI_API_KEY=sk-secret123456 for workflow", kind: "successful_workflow", tags: ["workflow"], scope: { topics: ["verification"] } }, ctx)
    const queried = await registry.run("memory_query", { query: "workflow" }, ctx)

    expect(added.metadata.status).toBe("succeeded")
    expect(added.metadata.kind).toBe("successful_workflow")
    expect(queried.output).toContain("workflow")
    expect(queried.output).toContain("[successful_workflow]")
    expect(queried.output).toContain("[redacted]")
    expect(queried.output).not.toContain("sk-secret123456")
  })

  test("memory_promote stores concise durable lessons and rejects oversized payloads", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const ctx = toolContext(root)

    const promoted = await registry.run("memory_promote", {
      text: "Remember that this repo expects bun run gate after each completed slice.",
      kind: "successful_workflow",
      tags: ["workflow"],
      scope: { topics: ["verification"] },
    }, ctx)
    const rejected = await registry.run("memory_promote", {
      text: "x".repeat(401),
      kind: "repo_fact",
    }, ctx)

    expect(promoted.metadata.status).toBe("succeeded")
    expect(promoted.metadata.kind).toBe("successful_workflow")
    expect(promoted.output).toContain("Promoted")
    expect(rejected.metadata.status).toBe("failed")
    expect(rejected.output).toContain("under 400 characters")
  })

  test("connector tools list and call static configured commands", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "connectors.json"), JSON.stringify({ tools: [{ name: "docs", description: "local docs", command: "printf connector-ok" }] }))
    const ctx = toolContext(root)

    const listed = await registry.run("connector_list", {}, ctx)
    const called = await registry.run("connector_call", { name: "docs" }, ctx)

    expect(listed.output).toContain("docs: local docs")
    expect(called.output).toBe("connector-ok")
    expect(called.metadata.connector).toBe("docs")
  })

  test("mcp and web search tools return cited fixture-backed evidence", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "mcp.json"), JSON.stringify({
      servers: [
        {
          name: "local-docs",
          resources: [
            { uri: "doc://agent/tui", title: "TUI design", description: "Terminal UI contract", text: "The TUI reuses the existing CLI runner." },
            { uri: "doc://agent/retrieval", title: "Retrieval design", description: "MCP and WebSearch share citations.", text: "Every source keeps a retrieved timestamp." },
          ],
        },
      ],
    }))
    await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
      results: [
        { url: "https://code.claude.com/docs", title: "Claude Code overview", snippet: "Claude Code is an agentic coding tool.", source: "Anthropic", retrievedAt: "2026-05-28T00:00:00.000Z" },
        { url: "https://github.com/opencode-ai/opencode", title: "OpenCode", snippet: "A terminal AI coding agent.", source: "GitHub", retrievedAt: "2026-05-28T00:00:00.000Z" },
      ],
    }))
    const ctx = toolContext(root)

    const listed = await registry.run("mcp_list_resources", { query: "retrieval", limit: 2 }, ctx)
    const read = await registry.run("mcp_read_resource", { uri: "doc://agent/retrieval", server: "local-docs" }, ctx)
    const searched = await registry.run("web_search", { query: "Claude Code", limit: 1 }, ctx)

    expect(listed.output).toContain("[mcp:1] Retrieval design")
    expect(Array.isArray(listed.metadata.sources)).toBe(true)
    expect(read.output).toContain("MCP and WebSearch share citations")
    expect(read.metadata.source).toMatchObject({ type: "mcp", uri: "doc://agent/retrieval" })
    expect(searched.output).toContain("[web:1] Claude Code overview")
    expect(searched.metadata).toMatchObject({ status: "succeeded", live: false, count: 1 })
    expect(searched.metadata.sources).toEqual([
      {
        type: "web",
        id: "https://code.claude.com/docs",
        title: "Claude Code overview",
        url: "https://code.claude.com/docs",
        retrievedAt: "2026-05-28T00:00:00.000Z",
      },
    ])
  })

  test("retrieval tools do not fabricate sources when fixtures are missing", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const ctx = toolContext(root)

    const mcp = await registry.run("mcp_list_resources", { query: "missing" }, ctx)
    const web = await registry.run("web_search", { query: "latest codex" }, ctx)

    expect(mcp.output).toBe("No MCP resources found.")
    expect(mcp.metadata).toMatchObject({ status: "succeeded", count: 0 })
    expect(mcp.metadata.sources).toEqual([])
    expect(web.output).toBe("No web search results found.")
    expect(web.metadata).toMatchObject({ status: "succeeded", count: 0, live: false })
    expect(web.metadata.sources).toEqual([])
  })

  test("web_fetch returns bounded structured HTTP evidence", async () => {
    const registry = createBuiltinRegistry()
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const accept = request.headers.get("accept") ?? "missing"
        return new Response("<html><title>Example Page</title><body>Hello from web_fetch.</body></html>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: `"accept:${accept}"`,
          },
        })
      },
    })
    try {
      const result = await registry.run("web_fetch", {
        url: `http://127.0.0.1:${server.port}/docs`,
        followRedirects: true,
        headers: { accept: "text/html" },
      }, toolContext())

      expect(result.metadata).toMatchObject({
        status: "succeeded",
        method: "GET",
        httpStatus: 200,
        contentType: "text/html; charset=utf-8",
      })
      expect(result.output).toContain("[web_fetch] GET")
      expect(result.output).toContain("Hello from web_fetch.")
      expect(result.metadata.source).toMatchObject({
        type: "web",
        title: "Example Page",
      })
    } finally {
      await server.stop(true)
    }
  })

  test("git workflow tools stage explicit files and reject unrelated staged commits", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await git(root, ["init"])
    await Bun.write(path.join(root, "a.txt"), "a1\n")
    await Bun.write(path.join(root, "b.txt"), "b1\n")
    await git(root, ["add", "a.txt", "b.txt"])
    await git(root, ["commit", "-m", "initial"])
    await Bun.write(path.join(root, "a.txt"), "a2\n")
    await Bun.write(path.join(root, "b.txt"), "b2\n")
    await git(root, ["add", "b.txt"])
    const ctx = toolContext(root)

    const status = await registry.run("git_status", {}, ctx)
    const commit = await registry.run("git_commit", { message: "update a", files: ["a.txt"] }, ctx)

    expect(status.output).toContain("b.txt")
    expect(commit.metadata.status).toBe("failed")
    expect(commit.output).toContain("unrelated staged files")
  })

  test("bash keeps command output out of metadata", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const result = await registry.run("bash", { command: "printf hello" }, toolContext(root))
    expect(result.output).toBe("hello")
    expect(result.metadata.status).toBe("succeeded")
    expect(result.metadata.command).toBe("printf hello")
    expect(result.metadata.stdout).toBeUndefined()
    expect(result.metadata.stderr).toBeUndefined()
  })

  test("bash asks before bypassing native write sandbox failures", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const requests: string[] = []
    const calls: Array<{ bypassNativeWriteSandbox?: boolean; bypassPathBoundary?: boolean } | undefined> = []
    const sandbox = {
      root,
      execute: async (_input: unknown, _mode: unknown, options?: { bypassNativeWriteSandbox?: boolean; bypassPathBoundary?: boolean }) => {
        calls.push(options)
        return options?.bypassNativeWriteSandbox
          ? bashResult({ command: "pwd", exitCode: 0, stdout: "ok", nativeWriteSandbox: false, sandboxBypassed: true })
          : bashResult({
              command: "pwd",
              exitCode: 1,
              stderr: "fatal: could not open '/dev/null' for reading and writing: Operation not permitted",
              nativeWriteSandbox: true,
              sandboxBypassed: false,
            })
      },
    } as unknown as Sandbox
    const permission = new PermissionService(
      [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "sandbox_bypass", pattern: "*", action: "ask" },
      ],
      (request) => {
        requests.push(request.permission)
        expect(request.metadata.reason).toBe("native_write_sandbox_denial")
        expect(request.metadata.risk).toContain("without the macOS write sandbox")
        return "once"
      },
    )

    const result = await registry.run("bash", { command: "pwd" }, { agentMode: "build", sandbox, permission, skills: new SkillService(root), messages: [] })

    expect(requests).toEqual(["sandbox_bypass"])
    expect(calls.map((call) => Boolean(call?.bypassNativeWriteSandbox))).toEqual([false, true])
    expect(result.output).toBe("ok")
    expect(result.metadata.status).toBe("succeeded")
    expect(result.metadata.sandboxBypassed).toBe(true)
  })

  test("bash repeats reuse the first approval in the same permission service", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    let asks = 0
    const permission = new PermissionService(defaultPermissionRules("build"), () => {
      asks += 1
      return "once"
    })
    const ctx = { agentMode: "build" as const, sandbox: new Sandbox(root), permission, skills: new SkillService(root), messages: [] }

    const first = await registry.run("bash", { command: "printf hello" }, ctx)
    const second = await registry.run("bash", { command: "printf hello" }, ctx)
    const third = await registry.run("bash", { command: "printf bye" }, ctx)

    expect(first.metadata.status).toBe("succeeded")
    expect(second.metadata.status).toBe("succeeded")
    expect(third.metadata.status).toBe("succeeded")
    expect(asks).toBe(2)
  })

  test("auto-reviewed non-replaceable bash results are marked as allowed after review", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const permission = new PermissionService(defaultPermissionRules("build"), () => {
      throw new Error("manual prompt should not be reached")
    }, defaultPermissionAutoReviewer)

    const result = await registry.run("bash", { command: "pwd" }, { agentMode: "build", sandbox: new Sandbox(root), permission, skills: new SkillService(root), messages: [] })

    expect(result.metadata.status).toBe("succeeded")
    expect(result.metadata.permissionAction).toBe("allow")
  })

  test("auto reviewer approves non-replaceable readonly bash only", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const sandbox = {
      root,
      resolve: (target = ".") => path.resolve(root, target),
      execute: async (input: { command: string }) => bashResult({ command: input.command, exitCode: 0, stdout: "ok" }),
    } as unknown as Sandbox
    const permission = new PermissionService(defaultPermissionRules("build"), () => {
      throw new Error("manual prompt should not be reached")
    }, defaultPermissionAutoReviewer)
    const ctx = { agentMode: "build" as const, sandbox, permission, skills: new SkillService(root), messages: [] }

    const pwdResult = await registry.run("bash", { command: "pwd" }, ctx)

    expect(pwdResult.metadata.status).toBe("succeeded")
    expect(pwdResult.metadata.permissionAction).toBe("allow")
  })

  test("non-autoapproved git bash still requires manual approval", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const sandbox = {
      root,
      resolve: (target = ".") => path.resolve(root, target),
      execute: async (input: { command: string }) => bashResult({ command: input.command, exitCode: 0, stdout: "ok" }),
    } as unknown as Sandbox
    const requested: string[] = []
    const permission = new PermissionService(defaultPermissionRules("build"), (request) => {
      requested.push(request.patterns.join(","))
      return "once"
    }, defaultPermissionAutoReviewer)
    const ctx = { agentMode: "build" as const, sandbox, permission, skills: new SkillService(root), messages: [] }

    const gitDiff = await registry.run("bash", { command: "git diff HEAD~1 --stat" }, ctx)

    expect(gitDiff.metadata.status).toBe("succeeded")
    expect(requested).toEqual([
      "bash:exact:git diff HEAD~1 --stat",
    ])
  })

  test("unsupported curl patterns still fall back to bash instead of a fake web_fetch replacement", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const sandbox = {
      root,
      resolve: (target = ".") => path.resolve(root, target),
      execute: async (input: { command: string }) => bashResult({ command: input.command, exitCode: 0, stdout: "ok" }),
    } as unknown as Sandbox
    const requested: string[] = []
    const permission = new PermissionService(defaultPermissionRules("build"), (request) => {
      requested.push(request.patterns.join(","))
      return "once"
    }, defaultPermissionAutoReviewer)
    const ctx = { agentMode: "build" as const, sandbox, permission, skills: new SkillService(root), messages: [] }

    const curlWithHeader = await registry.run("bash", { command: "curl -H Authorization:secret https://example.com" }, ctx)
    const curlWithOutput = await registry.run("bash", { command: "curl -o page.html https://example.com" }, ctx)
    const curlPost = await registry.run("bash", { command: "curl -X POST https://example.com" }, ctx)

    expect(curlWithHeader.metadata.status).toBe("succeeded")
    expect(curlWithHeader.metadata.error).toBeUndefined()
    expect(curlWithHeader.metadata.replaceableBy).toEqual([])
    expect(curlWithOutput.metadata.status).toBe("succeeded")
    expect(curlWithOutput.metadata.replaceableBy).toEqual([])
    expect(curlPost.metadata.status).toBe("succeeded")
    expect(curlPost.metadata.replaceableBy).toEqual([])
    expect(requested).toEqual([
      "bash:exact:curl -H Authorization:secret https://example.com",
      "bash:exact:curl -o page.html https://example.com",
      "bash:exact:curl -X POST https://example.com",
    ])
  })

  test("blocks replaceable bash commands and points to internal tools", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const permission = new PermissionService(defaultPermissionRules("build"), () => {
      throw new Error("permission prompt should not be reached")
    }, defaultPermissionAutoReviewer)
    const sandbox = {
      root,
      resolve: (target = ".") => path.resolve(root, target),
      execute: async () => {
        throw new Error("sandbox execute should not be reached")
      },
    } as unknown as Sandbox
    const ctx = { agentMode: "build" as const, sandbox, permission, skills: new SkillService(root), messages: [] }

    const gitStatus = await registry.run("bash", { command: "git status --short" }, ctx)
    const grepResult = await registry.run("bash", { command: "grep -n foo src/index.ts | head -20" }, ctx)
    const curlResult = await registry.run("bash", { command: "curl --retry 2 --connect-timeout 5 --url https://example.com/api -H 'Accept: application/json' -A easycode/1.0" }, ctx)

    expect(gitStatus.metadata.status).toBe("failed")
    expect(gitStatus.metadata.error).toBe("bash_replaced_by_internal_tool")
    expect(gitStatus.metadata.commandClass).toBe("git_inspect")
    expect(gitStatus.metadata.replaceableBy).toEqual(["git_status"])
    expect(gitStatus.output).toContain("git_status")

    expect(grepResult.metadata.status).toBe("failed")
    expect(grepResult.metadata.error).toBe("bash_replaced_by_internal_tool")
    expect(grepResult.metadata.commandClass).toBe("text_search")
    expect(grepResult.metadata.replaceableBy).toEqual(["rg_search", "grep"])
    expect(grepResult.output).toContain("rg_search")

    expect(curlResult.metadata.status).toBe("failed")
    expect(curlResult.metadata.error).toBe("bash_replaced_by_internal_tool")
    expect(curlResult.metadata.commandClass).toBe("http_fetch")
    expect(curlResult.metadata.replaceableBy).toEqual(["web_fetch"])
    expect(curlResult.metadata.suggestedWebFetchInput).toEqual({
      method: "GET",
      url: "https://example.com/api",
      headers: {
        accept: "application/json",
        "user-agent": "easycode/1.0",
      },
      retries: 2,
      timeoutMs: 5000,
    })
    expect(curlResult.output).toContain("web_fetch")
  })

  test("bash does not retry sandbox bypass when rejected", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const calls: Array<{ bypassNativeWriteSandbox?: boolean; bypassPathBoundary?: boolean } | undefined> = []
    const sandbox = {
      root,
      execute: async (_input: unknown, _mode: unknown, options?: { bypassNativeWriteSandbox?: boolean; bypassPathBoundary?: boolean }) => {
        calls.push(options)
        return bashResult({
          command: "pwd",
          exitCode: 1,
          stderr: "fatal: could not open '/dev/null' for reading and writing: Operation not permitted",
          nativeWriteSandbox: true,
          sandboxBypassed: false,
        })
      },
    } as unknown as Sandbox
    const permission = new PermissionService(
      [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "sandbox_bypass", pattern: "*", action: "ask" },
      ],
      () => "reject",
    )

    const result = await registry.run("bash", { command: "pwd" }, { agentMode: "build", sandbox, permission, skills: new SkillService(root), messages: [] })

    expect(calls).toHaveLength(1)
    expect(result.metadata.status).toBe("failed")
    expect(result.output).toContain("Sandbox bypass was not approved")
  })

  test("bash asks before bypassing explicit path boundary", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const requests: string[] = []
    const sandbox = {
      root,
      execute: async (input: { command: string }, _mode: unknown, options?: { bypassPathBoundary?: boolean }) => {
        if (!options?.bypassPathBoundary) throw new SandboxPathEscapeError("/var/folders", "/var/folders", root)
        return bashResult({ command: input.command, exitCode: 0, stdout: "ok", pathBoundaryBypassed: true })
      },
    } as unknown as Sandbox
    const result = await registry.run(
      "bash",
      { command: "ls /var/folders" },
      {
        agentMode: "build",
        sandbox,
        permission: new PermissionService(
          [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "sandbox_bypass", pattern: "*", action: "ask" },
          ],
          (request) => {
            requests.push(request.permission)
            expect(request.metadata.reason).toBe("path_boundary_escape")
            expect(request.metadata.risk).toContain("project-root path boundary")
            expect(request.metadata.reference).toBe("/var/folders")
            return "once"
          },
        ),
        skills: new SkillService(root),
        messages: [],
      },
    )

    expect(requests).toEqual(["sandbox_bypass"])
    expect(result.metadata.status).toBe("succeeded")
    expect(result.metadata.pathBoundaryBypassed).toBe(true)
    expect(result.metadata.sandboxBypassed).toBe(false)
  })

  test("read-only ls approvals reuse scoped outside-path approvals", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const outside = await mkdtemp(path.join(os.tmpdir(), "easycode-outside-"))
    tempRoots.push(outside)
    const requests: string[] = []
    const permission = new PermissionService(defaultPermissionRules("build"), (request) => {
      requests.push(`${request.permission}:${String(request.metadata.approvalScope ?? "")}`)
      return "once"
    })
    const sandbox = {
      root,
      execute: async (input: { command: string }, _mode: unknown, options?: { bypassPathBoundary?: boolean }) => {
        if (!options?.bypassPathBoundary) throw new SandboxPathEscapeError(outside, outside, root)
        return bashResult({ command: input.command, exitCode: 0, stdout: "ok", pathBoundaryBypassed: true })
      },
    } as unknown as Sandbox
    const ctx = { agentMode: "build" as const, sandbox, permission, skills: new SkillService(root), messages: [] }

    const first = await registry.run("bash", { command: `ls ${path.join(outside, "a")}` }, ctx)
    const second = await registry.run("bash", { command: `ls ${path.join(outside, "b")}` }, ctx)

    expect(first.metadata.status).toBe("succeeded")
    expect(second.metadata.status).toBe("succeeded")
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain("bash:readonly ls")
    expect(requests[1]).toContain("sandbox_bypass:path_boundary_escape readonly ls")
  })
})

function toolContext(root = import.meta.dir, messages: Message[] = []) {
  return { agentMode: "build" as const, sandbox: new Sandbox(root), permission: PermissionService.autoApprove(defaultPermissionRules("build")), skills: new SkillService(root), messages }
}

async function git(root: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

function bashResult(input: Partial<BashResult> & Pick<BashResult, "command" | "exitCode">): BashResult {
  return {
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: false,
    truncated: false,
    durationMs: 1,
    nativeWriteSandbox: false,
    sandboxBypassed: false,
    pathBoundaryBypassed: false,
    ...input,
  }
}
