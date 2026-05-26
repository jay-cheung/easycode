import { defaultProviderCapabilities, type Provider, type ProviderCapabilities, type ProviderEvent, type ProviderInput } from "./types"
import { parseProviderToolArguments } from "../tool/utils/arguments"
import type { ProviderInputMessage, ToolCall } from "../message"
import type { ToolDef } from "../tool"

const toolCallPattern = /<easycode_tool_call\b([^>]*)>([\s\S]*?)<\/easycode_tool_call>/gi

export class TextToolProtocolProvider implements Provider {
  readonly name: string
  readonly model?: string
  readonly capabilities: ProviderCapabilities
  private readonly inner: Provider

  constructor(inner: Provider, options: { name?: string; model?: string } = {}) {
    this.inner = inner
    this.name = options.name ?? `${inner.name}-text-tools`
    this.model = options.model ?? inner.model
    this.capabilities = {
      ...defaultProviderCapabilities,
      ...inner.capabilities,
      apiStyle: "text_tool_protocol",
    }
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    let bufferedText = ""
    let flushed = false
    const flush = function* () {
      if (flushed) return
      flushed = true
      yield* textToolProtocolOutputToProviderEvents(bufferedText)
    }

    for await (const event of this.inner.stream(textToolProtocolInput(input))) {
      if (event.type === "text_delta") {
        bufferedText += event.text
        continue
      }
      if (event.type === "done") {
        yield* flush()
        yield event
        continue
      }
      yield event
    }
    yield* flush()
  }
}

export function textToolProtocolInput(input: ProviderInput): ProviderInput {
  if (input.tools.length === 0) return { ...input, tools: [] }
  return {
    ...input,
    providerMessages: [textToolProtocolPrompt(input.tools), ...input.providerMessages],
    tools: [],
  }
}

export function textToolProtocolOutputToProviderEvents(text: string): ProviderEvent[] {
  const events: ProviderEvent[] = []
  let cursor = 0
  let index = 0
  for (const match of text.matchAll(toolCallPattern)) {
    const start = match.index ?? 0
    const before = text.slice(cursor, start)
    if (before) events.push({ type: "text_delta", text: before })
    index += 1
    events.push({ type: "tool_call", call: toolCallFromTextProtocol(match[1] ?? "", match[2] ?? "", index) })
    cursor = start + match[0].length
  }
  const tail = text.slice(cursor)
  if (tail) events.push({ type: "text_delta", text: tail })
  if (events.length === 0 && text) events.push({ type: "text_delta", text })
  return events.filter((event) => event.type !== "text_delta" || event.text.length > 0)
}

function textToolProtocolPrompt(tools: ToolDef[]): ProviderInputMessage {
  return {
    role: "system",
    content: [
      "Text tool protocol:",
      "This model endpoint does not receive native tool schemas. When a tool is needed, emit exactly one XML block and no markdown fence:",
      '<easycode_tool_call name="tool_name" id="optional_call_id">{"argument":"value"}</easycode_tool_call>',
      "Available tools:",
      ...tools.map(formatTextTool),
    ].join("\n"),
  }
}

function formatTextTool(tool: ToolDef) {
  return `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.jsonSchema)}`
}

function toolCallFromTextProtocol(attributes: string, rawArguments: string, index: number): ToolCall {
  const name = attributeValue(attributes, "name") ?? "unknown"
  const id = attributeValue(attributes, "id") ?? `call_text_${index}`
  const argumentsText = rawArguments.trim() || "{}"
  const parsed = parseProviderToolArguments(argumentsText, name, id)
  return { id, name, input: parsed.input, rawArguments: argumentsText }
}

function attributeValue(attributes: string, name: string) {
  const match = attributes.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"))
  return match?.[1]
}
