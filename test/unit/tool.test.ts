import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { createBuiltinRegistry, ToolRegistry } from "../../src/tool"
import { ContextManager } from "../../src/context"
import { type BashResult, Sandbox } from "../../src/sandbox"
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

  test("filters tools by mode", () => {
    const registry = createBuiltinRegistry()
    expect(registry.list("plan").some((tool) => tool.name === "edit")).toBe(false)
    expect(registry.list("build").some((tool) => tool.name === "edit")).toBe(true)
    expect(registry.list("plan").some((tool) => tool.name === "plan_exit")).toBe(true)
    expect(registry.list("build").some((tool) => tool.name === "plan_exit")).toBe(false)
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

  test("registers semantic navigation and diff tools in plan and build mode", () => {
    const registry = createBuiltinRegistry()
    for (const name of ["rg_search", "read_lines", "find_definition", "find_references", "call_graph", "repo_map", "git_diff", "git_status", "git_branch", "git_log"]) {
      expect(registry.list("plan").some((tool) => tool.name === name)).toBe(true)
      expect(registry.list("build").some((tool) => tool.name === name)).toBe(true)
    }
    for (const name of ["patch", "git_stage", "git_commit", "git_restore_guarded", "memory_add", "connector_call"]) {
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

    const added = await registry.run("memory_add", { text: "OPENAI_API_KEY=sk-secret123456 for task", tags: ["task"] }, ctx)
    const queried = await registry.run("memory_query", { query: "task" }, ctx)

    expect(added.metadata.status).toBe("succeeded")
    expect(queried.output).toContain("task")
    expect(queried.output).toContain("[redacted]")
    expect(queried.output).not.toContain("sk-secret123456")
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
          ? bashResult({ command: "git log", exitCode: 0, stdout: "ok", nativeWriteSandbox: false, sandboxBypassed: true })
          : bashResult({
              command: "git log",
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

    const result = await registry.run("bash", { command: "git log" }, { agentMode: "build", sandbox, permission, skills: new SkillService(root), messages: [] })

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

  test("auto-reviewed bash results are marked as allowed after review", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await git(root, ["init"])
    const permission = new PermissionService(defaultPermissionRules("build"), () => {
      throw new Error("manual prompt should not be reached")
    }, defaultPermissionAutoReviewer)

    const result = await registry.run("bash", { command: "git status --short" }, { agentMode: "build", sandbox: new Sandbox(root), permission, skills: new SkillService(root), messages: [] })

    expect(result.metadata.status).toBe("succeeded")
    expect(result.metadata.permissionAction).toBe("allow")
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
          command: "git log",
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

    const result = await registry.run("bash", { command: "git log" }, { agentMode: "build", sandbox, permission, skills: new SkillService(root), messages: [] })

    expect(calls).toHaveLength(1)
    expect(result.metadata.status).toBe("failed")
    expect(result.output).toContain("Sandbox bypass was not approved")
  })

  test("bash asks before bypassing explicit path boundary", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    const requests: string[] = []
    const result = await registry.run(
      "bash",
      { command: "ls /var/folders" },
      {
        agentMode: "build",
        sandbox: new Sandbox(root),
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
    await mkdir(path.join(outside, "a"))
    await mkdir(path.join(outside, "b"))
    const requests: string[] = []
    const permission = new PermissionService(defaultPermissionRules("build"), (request) => {
      requests.push(`${request.permission}:${String(request.metadata.approvalScope ?? "")}`)
      return "once"
    })
    const ctx = { agentMode: "build" as const, sandbox: new Sandbox(root), permission, skills: new SkillService(root), messages: [] }

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
