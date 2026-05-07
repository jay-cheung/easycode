import { ToolCall, Message, toolResults } from "../message"
import { JsonSchema, ToolDef } from "../tool"

export function call(name: string, input: unknown): ToolCall {
  return { id: `call_${Date.now().toString(36)}_${name}`, name, input }
}

export function hasToolResult(messages: Message[], toolName: string) {
  return toolResults(messages).some((result) => result.toolName === toolName)
}

export function latestToolResult(messages: Message[], toolName: string) {
  return [...toolResults(messages)].reverse().find((result) => result.toolName === toolName)
}

function nullableType(type: unknown) {
  if (Array.isArray(type)) return type.includes("null") ? type : [...type, "null"]
  if (typeof type === "string") return type === "null" ? type : [type, "null"]
  return type
}

function strictResponseSchema(schema: JsonSchema): JsonSchema {
  const originallyRequired = new Set(schema.required ?? Object.keys(schema.properties))
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([name, property]) => {
      if (originallyRequired.has(name)) return [name, property]
      return [name, { ...property, type: nullableType(property.type) }]
    }),
  )
  return { ...schema, properties, required: Object.keys(schema.properties) }
}

export function toolToResponseTool(tool: ToolDef) {
  return { type: "function", name: tool.name, description: tool.description, parameters: strictResponseSchema(tool.jsonSchema), strict: true }
}
