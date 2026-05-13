import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { createBuiltinRegistry, ToolRegistry } from "../../src/tool"
import { Sandbox } from "../../src/sandbox"
import { PermissionService, defaultPermissionRules } from "../../src/permission"
import { SkillService } from "../../src/skill"
import { mkdtemp, rm } from "node:fs/promises"
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
})

function toolContext(root = import.meta.dir) {
  return { agentMode: "build" as const, sandbox: new Sandbox(root), permission: PermissionService.autoApprove(defaultPermissionRules("build")), skills: new SkillService(root), messages: [] }
}
