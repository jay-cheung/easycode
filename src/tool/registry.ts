import type { z } from "zod"
import type { AgentMode, Message } from "../message"
import { PermissionDeniedError, PermissionRejectedError, type PermissionRequest, type PermissionService } from "../permission"
import type { Sandbox } from "../sandbox"
import type { SkillServiceLike } from "../skill"
import type { ContextManagerLike } from "../context/types"
import { BashInput, bashApprovalForCommand, bashCwd } from "./bash"
import { findDuplicateInspection } from "./utils/duplicate-inspection"
import { invalidProviderToolArguments } from "./utils/arguments"

export type JsonSchema = {
  type: "object"
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties: boolean
}

export type ToolResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
}

export type ToolContext = {
  agentMode: AgentMode
  sandbox: Sandbox
  permission: PermissionService
  skills: SkillServiceLike
  messages: Message[]
  context?: ContextManagerLike
  signal?: AbortSignal
  onExecuteStart?: (name: string) => void
}

export type ToolDef = {
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  jsonSchema: JsonSchema
  permission: string
  modes: AgentMode[]
  patterns(input: unknown, ctx: ToolContext): string[]
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolRegistryLike {
  get(name: string): ToolDef | undefined
  list(mode?: AgentMode): ToolDef[]
  run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export class ToolRegistry implements ToolRegistryLike {
  private readonly tools = new Map<string, ToolDef>()

  register(tool: ToolDef) {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string) {
    return this.tools.get(name)
  }

  list(mode?: AgentMode) {
    return [...this.tools.values()].filter((tool) => !mode || tool.modes.includes(mode))
  }

  async run(name: string, input: unknown, ctx: ToolContext) {
    const tool = this.get(name)
    if (!tool) return { title: "Unknown tool", output: `Tool not found: ${name}`, metadata: { status: "failed" } }
    if (!tool.modes.includes(ctx.agentMode)) {
      return { title: "Tool disabled", output: `Tool ${name} is not available in ${ctx.agentMode} mode`, metadata: { status: "denied" } }
    }
    const providerArgumentError = invalidProviderToolArguments(input)
    if (providerArgumentError) {
      return { title: "Invalid tool input", output: providerArgumentError, metadata: { status: "failed", error: "invalid_tool_arguments" } }
    }
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return { title: "Invalid tool input", output: `Invalid arguments for ${name}: ${parsed.error.message}`, metadata: { status: "failed", validation: parsed.error.issues } }
    }
    const duplicateInspection = findDuplicateInspection(ctx.messages, name, parsed.data)
    if (duplicateInspection) {
      return {
        title: "Duplicate inspection blocked",
        output: `Duplicate inspection blocked for ${duplicateInspection.description}. Reuse the previous result unless new evidence, a file change, or a verification failure requires re-inspection.`,
        metadata: { status: "failed", error: "duplicate_inspection", tool: name, duplicateTarget: duplicateInspection.description },
      }
    }
    try {
      const patterns = tool.patterns(parsed.data, ctx)
      const request = permissionRequestForTool(tool, parsed.data, ctx, patterns)
      const permissionDecisions = request.patterns.map((pattern) => ({ pattern, action: ctx.permission.evaluate(tool.permission, pattern) }))
      const permissionAction = permissionActionFor(permissionDecisions.map((decision) => decision.action))
      if (ctx.signal?.aborted) return toolCancelledResult(name)
      await ctx.permission.authorize(request, permissionDecisions)
      if (ctx.signal?.aborted) return toolCancelledResult(name)
      ctx.onExecuteStart?.(name)
      const result = await tool.execute(parsed.data, ctx)
      const finalPermissionAction = permissionAction === "ask" ? permissionActionFor(request.patterns.map((pattern) => ctx.permission.evaluate(tool.permission, pattern))) : permissionAction
      return { ...result, metadata: { ...result.metadata, permission: tool.permission, permissionAction: finalPermissionAction, patterns: request.patterns } }
    } catch (error) {
      return toolErrorResult(name, error)
    }
  }
}

function permissionActionFor(actions: string[]) {
  if (actions.includes("deny")) return "deny"
  if (actions.includes("ask")) return "ask"
  return "allow"
}

function toolErrorResult(name: string, error: unknown): ToolResult {
  if (error instanceof PermissionDeniedError || error instanceof PermissionRejectedError) {
    return { title: name, output: error.message, metadata: { status: "denied", error: error.name } }
  }
  return {
    title: name,
    output: error instanceof Error ? error.message : String(error),
    metadata: { status: "failed", error: error instanceof Error ? error.name : "UnknownError" },
  }
}

function toolCancelledResult(name: string): ToolResult {
  return { title: name, output: "Tool cancelled by user.", metadata: { status: "failed", cancelled: true, error: "AbortError" } }
}


function permissionRequestForTool(tool: ToolDef, input: unknown, ctx: ToolContext, patterns: string[]): Omit<PermissionRequest, "id"> {
  if (tool.name === "bash") {
    const params = BashInput.parse(input)
    const approval = bashApprovalForCommand(params.command, bashCwd(ctx, params.cwd))
    return {
      permission: tool.permission,
      patterns: [approval.target],
      always: approval.rememberPatterns,
      metadata: {
        tool: tool.name,
        command: params.command,
        approvalScope: approval.label,
        rememberOnApprove: approval.repeatSafe,
        rememberPatterns: approval.rememberPatterns,
      },
    }
  }
  return { permission: tool.permission, patterns, always: patterns, metadata: { tool: tool.name } }
}
