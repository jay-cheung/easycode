import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { createBuiltinRegistry, ToolRegistry } from "../../src/tool"
import { type BashResult, Sandbox } from "../../src/sandbox"
import { PermissionService, defaultPermissionRules } from "../../src/permission"
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

function bashResult(input: Partial<BashResult> & Pick<BashResult, "command" | "exitCode">): BashResult {
  return {
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
    nativeWriteSandbox: false,
    sandboxBypassed: false,
    pathBoundaryBypassed: false,
    ...input,
  }
}
