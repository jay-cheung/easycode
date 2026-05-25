import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { createBuiltinRegistry, ToolRegistry } from "../../src/tool"
import { ContextManager } from "../../src/context"
import { type BashResult, Sandbox } from "../../src/sandbox"
import { PermissionService, defaultPermissionAutoReviewer, defaultPermissionRules } from "../../src/permission"
import { SkillService } from "../../src/skill"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

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
    for (const name of ["rg_search", "read_lines", "find_definition", "find_references", "call_graph", "repo_map", "git_diff"]) {
      expect(registry.list("plan").some((tool) => tool.name === name)).toBe(true)
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

  test("read blocks large files and points to semantic navigation", async () => {
    const registry = createBuiltinRegistry()
    const root = await tmpdir()
    await Bun.write(path.join(root, "large.ts"), Array.from({ length: 101 }, (_, index) => `export const v${index} = ${index}`).join("\n"))

    const result = await registry.run("read", { filePath: "large.ts" }, toolContext(root))

    expect(result.metadata.status).toBe("failed")
    expect(result.metadata.error).toBe("large_file_read_forbidden")
    expect(result.output).toContain("Use repo_map first")
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

function toolContext(root = import.meta.dir) {
  return { agentMode: "build" as const, sandbox: new Sandbox(root), permission: PermissionService.autoApprove(defaultPermissionRules("build")), skills: new SkillService(root), messages: [] }
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
