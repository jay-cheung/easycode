import path from "node:path"
import { z } from "zod"
import type { AgentMode, Message } from "./message"
import type { PermissionService } from "./permission"
import type { Sandbox } from "./sandbox"
import type { SkillServiceLike } from "./skill"

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
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return { title: "Invalid tool input", output: `Invalid arguments for ${name}: ${parsed.error.message}`, metadata: { status: "failed", validation: parsed.error.issues } }
    }
    const patterns = tool.patterns(parsed.data, ctx)
    await ctx.permission.authorize({
      permission: tool.permission,
      patterns,
      always: patterns,
      metadata: { tool: name },
    })
    return tool.execute(parsed.data, ctx)
  }
}

function objectSchema(properties: JsonSchema["properties"], required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

const ReadInput = z.object({ filePath: z.string() })
const OptionalString = z.string().nullish().transform((value) => value ?? undefined)
const OptionalBoolean = z.boolean().nullish().transform((value) => value ?? undefined)
const OptionalNumber = z.number().nullish().transform((value) => value ?? undefined)
const ListInput = z.object({ dirPath: OptionalString })
const GrepInput = z.object({ query: z.string(), dir: OptionalString })
const WriteInput = z.object({ filePath: z.string(), content: z.string() })
const EditInput = z.object({ filePath: z.string(), oldString: z.string(), newString: z.string(), replaceAll: OptionalBoolean })
const BashInput = z.object({ command: z.string(), cwd: OptionalString, timeoutMs: OptionalNumber })
const SkillInput = z.object({ name: z.string() })
const PlanExitInput = z.object({ markdown: z.string() })

function relativePattern(ctx: ToolContext, filePath: string) {
  const resolved = path.resolve(ctx.sandbox.root, filePath)
  return ctx.sandbox.contains(resolved) ? path.relative(ctx.sandbox.root, resolved) || "." : resolved
}

export function createBuiltinRegistry() {
  const registry = new ToolRegistry()

  registry.register({
    name: "read",
    description: "Read a file inside the project root.",
    inputSchema: ReadInput,
    jsonSchema: objectSchema({ filePath: { type: "string", description: "File path to read" } }),
    permission: "read",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, ReadInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = ReadInput.parse(input)
      return { title: params.filePath, output: await ctx.sandbox.readFile(params.filePath), metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "list",
    description: "List a directory inside the project root.",
    inputSchema: ListInput,
    jsonSchema: objectSchema({ dirPath: { type: "string", description: "Directory path" } }, []),
    permission: "list",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, ListInput.parse(input).dirPath ?? ".")],
    execute: async (input, ctx) => {
      const params = ListInput.parse(input)
      return { title: params.dirPath ?? ".", output: (await ctx.sandbox.list(params.dirPath)).join("\n"), metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "grep",
    description: "Search project files for a text query.",
    inputSchema: GrepInput,
    jsonSchema: objectSchema({ query: { type: "string" }, dir: { type: "string" } }, ["query"]),
    permission: "grep",
    modes: ["build", "plan"],
    patterns: (input, ctx) => [relativePattern(ctx, GrepInput.parse(input).dir ?? ".")],
    execute: async (input, ctx) => {
      const params = GrepInput.parse(input)
      return { title: params.query, output: (await ctx.sandbox.grep(params)).join("\n"), metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "write",
    description: "Write a file inside the project root.",
    inputSchema: WriteInput,
    jsonSchema: objectSchema({ filePath: { type: "string" }, content: { type: "string" } }),
    permission: "write",
    modes: ["build"],
    patterns: (input, ctx) => [relativePattern(ctx, WriteInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = WriteInput.parse(input)
      await ctx.sandbox.writeFile(params.filePath, params.content)
      return { title: params.filePath, output: "Write applied successfully.", metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "edit",
    description: "Replace text in a file inside the project root.",
    inputSchema: EditInput,
    jsonSchema: objectSchema({ filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" } }, ["filePath", "oldString", "newString"]),
    permission: "edit",
    modes: ["build"],
    patterns: (input, ctx) => [relativePattern(ctx, EditInput.parse(input).filePath)],
    execute: async (input, ctx) => {
      const params = EditInput.parse(input)
      const current = await ctx.sandbox.readFile(params.filePath)
      if (!current.includes(params.oldString)) throw new Error(`oldString not found in ${params.filePath}`)
      const next = params.replaceAll ? current.split(params.oldString).join(params.newString) : current.replace(params.oldString, params.newString)
      await ctx.sandbox.writeFile(params.filePath, next)
      return { title: params.filePath, output: "Edit applied successfully.", metadata: { status: "succeeded", changed: params.filePath } }
    },
  })

  registry.register({
    name: "bash",
    description: "Run a shell command through the sandbox.",
    inputSchema: BashInput,
    jsonSchema: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, ["command"]),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: (input) => [BashInput.parse(input).command],
    execute: async (input, ctx) => {
      const params = BashInput.parse(input)
      const result = await ctx.sandbox.execute(params, ctx.agentMode)
      return { title: params.command, output: [result.stdout, result.stderr].filter(Boolean).join("\n"), metadata: { status: result.exitCode === 0 ? "succeeded" : "failed", ...result } }
    },
  })

  registry.register({
    name: "skill",
    description: "Load the full content of a named skill.",
    inputSchema: SkillInput,
    jsonSchema: objectSchema({ name: { type: "string" } }),
    permission: "skill",
    modes: ["build", "plan"],
    patterns: (input) => [SkillInput.parse(input).name],
    execute: async (input, ctx) => {
      const params = SkillInput.parse(input)
      const skill = await ctx.skills.load(params.name)
      if (!skill) return { title: params.name, output: `Skill not found: ${params.name}`, metadata: { status: "failed" } }
      return { title: `Loaded skill: ${skill.name}`, output: skill.content ?? "", metadata: { status: "succeeded", location: skill.location } }
    },
  })

  registry.register({
    name: "plan_exit",
    description: "Return the final proposed plan in plan mode.",
    inputSchema: PlanExitInput,
    jsonSchema: objectSchema({ markdown: { type: "string" } }),
    permission: "plan_exit",
    modes: ["plan"],
    patterns: () => ["*"],
    execute: async (input) => {
      const params = PlanExitInput.parse(input)
      return { title: "Plan", output: `<proposed_plan>\n${params.markdown.trim()}\n</proposed_plan>`, metadata: { status: "succeeded" } }
    },
  })

  return registry
}
