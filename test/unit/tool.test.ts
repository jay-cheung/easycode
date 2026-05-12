import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { createBuiltinRegistry, ToolRegistry } from "../../src/tool"
import { Sandbox } from "../../src/sandbox"
import { PermissionService, defaultPermissionRules } from "../../src/permission"
import { SkillService } from "../../src/skill"

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
})

function toolContext() {
  const root = import.meta.dir
  return { agentMode: "build" as const, sandbox: new Sandbox(root), permission: PermissionService.autoApprove(defaultPermissionRules("build")), skills: new SkillService(root), messages: [] }
}
