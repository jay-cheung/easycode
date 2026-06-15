import { ConnectorService } from "../../connector"
import { formatProjectMemoryRecord, ProjectMemoryStore } from "../../memory"
import { BashInput, bashApprovalForCommand, bashCwd, bashResultToToolResult, executeBashWithSandboxRecovery, scopedBashApproval } from "../bash"
import { EditInput, PatchInput, WriteInput, relativePattern } from "../fs"
import type { ToolDef, ToolRegistry } from "../registry"
import { ConnectorCallInput, ConnectorListInput, LedgerInput, MemoryAddInput, MemoryPromoteInput, MemoryQueryInput, objectSchema } from "./common"

export function registerWorkspaceTools(registry: ToolRegistry) {
  registry.register({
    name: "patch",
    description: "Apply explicit multi-operation file patches inside the project root. Supports replace, create, delete, and move operations.",
    inputSchema: PatchInput,
    jsonSchema: objectSchema({
      operations: {
        type: "array",
        description: "Patch operations. Each item has type replace/create/delete/move and the required paths/content for that operation.",
        items: { type: "object" },
      },
    }),
    permission: "edit",
    modes: ["build"],
    patterns: (input, ctx) => patchPatterns(PatchInput.parse(input), ctx),
    execute: async (input, ctx) => {
      const params = PatchInput.parse(input)
      const changed: string[] = []
      for (const operation of params.operations) {
        if (operation.type === "replace") {
          const current = await ctx.sandbox.readFile(operation.filePath)
          if (!current.includes(operation.oldString)) throw new Error(`oldString not found in ${operation.filePath}`)
          const next = operation.replaceAll ? current.split(operation.oldString).join(operation.newString) : current.replace(operation.oldString, operation.newString)
          await ctx.sandbox.writeFile(operation.filePath, next)
          changed.push(operation.filePath)
        }
        if (operation.type === "create") {
          if (!operation.overwrite && await Bun.file(ctx.sandbox.resolve(operation.filePath)).exists()) throw new Error(`Refusing to overwrite existing file: ${operation.filePath}`)
          await ctx.sandbox.writeFile(operation.filePath, operation.content)
          changed.push(operation.filePath)
        }
        if (operation.type === "delete") {
          await ctx.sandbox.deleteFile(operation.filePath)
          changed.push(operation.filePath)
        }
        if (operation.type === "move") {
          await ctx.sandbox.moveFile(operation.fromPath, operation.toPath)
          changed.push(`${operation.fromPath} -> ${operation.toPath}`)
        }
      }
      return { title: "patch", output: changed.map((item) => `changed ${item}`).join("\n"), metadata: { status: "succeeded", changed, operations: params.operations.length } }
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
    description: "Replace text in a file inside the project root. By default only the first match is replaced.",
    inputSchema: EditInput,
    jsonSchema: objectSchema(
      {
        filePath: { type: "string", description: "File path to edit" },
        oldString: { type: "string", description: "Text to replace" },
        newString: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "When true, replace every match instead of only the first match" },
      },
      ["filePath", "oldString", "newString"],
    ),
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
    description: "Last-resort shell command execution. Do not use this for normal code exploration when dedicated tools can answer: prefer repo_map, find_definition, find_references, call_graph, rg_search, read_lines, and git_* tools first. Use bash only for commands those tools cannot express.",
    inputSchema: BashInput,
    jsonSchema: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, ["command"]),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: (input, ctx) => {
      const params = BashInput.parse(input)
      return [bashApprovalForCommand(params.command, bashCwd(ctx, params.cwd)).target]
    },
    execute: async (input, ctx) => {
      const params = BashInput.parse(input)
      const result = await executeBashWithSandboxRecovery(params, ctx)
      return bashResultToToolResult(params.command, result)
    },
  })

  registry.register({
    name: "ledger",
    description: "Pull the current structured context ledger only when the user asks to confirm progress or execute/continue a task and the current state is unclear, or when you are unsure about the active objective, status, or next step. Do not call this on every turn.",
    inputSchema: LedgerInput,
    jsonSchema: objectSchema({ query: { type: "string", description: "Optional reason or keyword for pulling the ledger." } }, []),
    permission: "read",
    modes: ["build", "plan"],
    patterns: () => ["context_ledger"],
    execute: async (_input, ctx) => {
      const output = ctx.context?.selectedLedgerText() ?? ""
      return {
        title: "context ledger",
        output: output || "No context ledger records.",
        metadata: { status: "succeeded", empty: output.length === 0 },
      }
    },
  })

  registry.register({
    name: "memory_query",
    description: "Query structured project memory for preferences, archived sessions, repo facts, or repeated failure/workflow notes.",
    inputSchema: MemoryQueryInput,
    jsonSchema: objectSchema({ query: { type: "string" }, maxResults: { type: "number" } }, ["query"]),
    permission: "read",
    modes: ["build", "plan"],
    patterns: () => [".easycode/memory.json"],
    execute: async (input, ctx) => {
      const params = MemoryQueryInput.parse(input)
      const records = await new ProjectMemoryStore(ctx.sandbox.root).query(params.query, params.maxResults)
      return { title: "project memory", output: records.map((record) => formatProjectMemoryRecord(record)).join("\n") || "No matching memory records.", metadata: { status: "succeeded", count: records.length } }
    },
  })

  registry.register({
    name: "memory_add",
    description: "Add a short structured project memory record. Use this for durable preferences, repo facts, archived session notes, repeated failures, or reusable workflows. Do not store secrets or raw logs.",
    inputSchema: MemoryAddInput,
    jsonSchema: objectSchema({
      text: { type: "string" },
      kind: { type: "string", description: "note, session_archive, preference, repo_fact, failure_pattern, or successful_workflow" },
      tags: { type: "array", items: { type: "string" } },
      scope: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          symbols: { type: "array", items: { type: "string" } },
          topics: { type: "array", items: { type: "string" } },
        },
        required: [],
        additionalProperties: false,
      },
    }, ["text"]),
    permission: "write",
    modes: ["build"],
    patterns: () => [".easycode/memory.json"],
    execute: async (input, ctx) => {
      const params = MemoryAddInput.parse(input)
      const record = await new ProjectMemoryStore(ctx.sandbox.root).add({ text: params.text, kind: params.kind, tags: params.tags, scope: params.scope })
      return { title: "project memory", output: `Added ${record.id} [${record.kind}]`, metadata: { status: "succeeded", id: record.id, kind: record.kind, tags: record.tags } }
    },
  })

  registry.register({
    name: "memory_promote",
    description: "Promote one durable cross-session lesson into project memory. Use this only for stable preferences, reusable repo facts, recurring failure diagnoses, or successful workflows. Do not store raw logs, transient chatter, or long narratives.",
    inputSchema: MemoryPromoteInput,
    jsonSchema: objectSchema({
      text: { type: "string", description: "One concise durable lesson, under 400 characters." },
      kind: { type: "string", description: "preference, repo_fact, failure_pattern, or successful_workflow" },
      tags: { type: "array", items: { type: "string" } },
      scope: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          symbols: { type: "array", items: { type: "string" } },
          topics: { type: "array", items: { type: "string" } },
        },
        required: [],
        additionalProperties: false,
      },
    }, ["text", "kind"]),
    permission: "write",
    modes: ["build"],
    patterns: () => [".easycode/memory.json"],
    execute: async (input, ctx) => {
      const params = MemoryPromoteInput.parse(input)
      const record = await new ProjectMemoryStore(ctx.sandbox.root).promote({
        text: params.text,
        kind: params.kind,
        tags: params.tags,
        scope: params.scope,
      })
      return { title: "project memory", output: `Promoted ${record.id} [${record.kind}]`, metadata: { status: "succeeded", id: record.id, kind: record.kind, tags: record.tags } }
    },
  })

  registry.register({
    name: "connector_list",
    description: "List locally configured external connector tools from .easycode/connectors.json.",
    inputSchema: ConnectorListInput,
    jsonSchema: objectSchema({}, []),
    permission: "read",
    modes: ["build", "plan"],
    patterns: () => [".easycode/connectors.json"],
    execute: async (_input, ctx) => {
      const tools = await new ConnectorService(ctx.sandbox.root).list()
      return { title: "connectors", output: tools.map((tool) => `${tool.name}: ${tool.description}`).join("\n") || "No connectors configured.", metadata: { status: "succeeded", count: tools.length } }
    },
  })

  registry.register({
    name: "connector_call",
    description: "Call one locally configured connector command. Connector commands are static and require bash permission.",
    inputSchema: ConnectorCallInput,
    jsonSchema: objectSchema({ name: { type: "string" } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("connector", "configured-command", [], false).target],
    execute: async (input, ctx) => {
      const params = ConnectorCallInput.parse(input)
      const { tool, result } = await new ConnectorService(ctx.sandbox.root).call(params.name, ctx.sandbox, ctx.signal)
      return { title: tool.name, output: bashResultToToolResult(tool.command, result).output, metadata: { ...bashResultToToolResult(tool.command, result).metadata, connector: tool.name } }
    },
  })
}

function patchPatterns(input: typeof PatchInput._output, ctx: Parameters<ToolDef["patterns"]>[1]) {
  return input.operations.flatMap((operation) => {
    if (operation.type === "move") return [relativePattern(ctx, operation.fromPath), relativePattern(ctx, operation.toPath)]
    return [relativePattern(ctx, operation.filePath)]
  })
}
