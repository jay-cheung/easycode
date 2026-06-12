import { defaultProviderCapabilities, type Provider, type ProviderCapabilities, type ProviderEvent, type ProviderInput } from "./types"
import { parseProviderToolArguments } from "../tool/utils/arguments"
import type { ToolCall } from "../message"
import { buildTextToolProtocolPrompt } from "../prompt"

const toolCallPattern = /<easycode_tool_call\b([^>]*)>([\s\S]*?)<\/easycode_tool_call>/gi
const singularToolCallPattern = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi

// Anthropic/Claude-style: <invoke name="tool_name">...<parameter name="key">value</parameter>...</invoke>
const invokePattern = /<(?:[|｜]{2}DSML[|｜]{2})?invoke\s+name\s*=\s*["']([^"']+)["'](?:\s+id\s*=\s*["']([^"']+)["'])?\s*>([\s\S]*?)<\/(?:[|｜]{2}DSML[|｜]{2})?invoke>/gi

// Outer wrapper that may contain multiple <invoke> blocks
const toolCallsBlockPattern = /<(?:[|｜]{2}DSML[|｜]{2})?tool_calls>([\s\S]*?)<\/(?:[|｜]{2}DSML[|｜]{2})?tool_calls>/gi

// Individual <parameter name="key" ...>value</parameter> inside an <invoke> block
const parameterPattern = /<(?:[|｜]{2}DSML[|｜]{2})?parameter\s+name\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/(?:[|｜]{2}DSML[|｜]{2})?parameter>/gi

export class TextToolProtocolProvider implements Provider {
  readonly name: string
  readonly model?: string
  readonly runtime?: Provider["runtime"]
  readonly capabilities: ProviderCapabilities
  private readonly inner: Provider

  constructor(inner: Provider, options: { name?: string; model?: string } = {}) {
    this.inner = inner
    this.name = options.name ?? `${inner.name}-text-tools`
    this.model = options.model ?? inner.model
    this.runtime = inner.runtime
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
    providerMessages: [buildTextToolProtocolPrompt(input.tools), ...input.providerMessages],
    tools: [],
  }
}

export function textToolProtocolOutputToProviderEvents(text: string): ProviderEvent[] {
  // Try easycode format first
  const easycodeEvents = parseEasycodeToolCalls(text)
  if (easycodeEvents.some((event) => event.type === "tool_call")) return easycodeEvents

  // Fall back to singular tool_call XML wrappers (<tool_call><invoke_name>...</invoke_name><args>...</args></tool_call>)
  const singularEvents = parseSingularToolCalls(text)
  if (singularEvents.some((event) => event.type === "tool_call")) return singularEvents

  // Fall back to Anthropic-style XML format (<tool_calls>/<invoke>/<parameter>)
  const anthropicEvents = parseAnthropicToolCalls(text)
  if (anthropicEvents.some((event) => event.type === "tool_call")) return anthropicEvents

  // No tool calls found, return as plain text
  if (text) return [{ type: "text_delta", text }]
  return []
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

function parseEasycodeToolCalls(text: string): ProviderEvent[] {
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
  return events.filter((event) => event.type !== "text_delta" || event.text.length > 0)
}

function parseSingularToolCalls(text: string): ProviderEvent[] {
  const events: ProviderEvent[] = []
  let cursor = 0
  let index = 0
  for (const match of text.matchAll(singularToolCallPattern)) {
    const start = match.index ?? 0
    const before = text.slice(cursor, start)
    if (before) events.push({ type: "text_delta", text: before })
    index += 1
    events.push({ type: "tool_call", call: singularToolCallFromXml(match[1] ?? "", match[2] ?? "", index) })
    cursor = start + match[0].length
  }
  const tail = text.slice(cursor)
  if (tail) events.push({ type: "text_delta", text: tail })
  return events.filter((event) => event.type !== "text_delta" || event.text.length > 0)
}

function singularToolCallFromXml(attributes: string, rawBody: string, index: number): ToolCall {
  const name = attributeValue(attributes, "name") ?? simpleTagValue(rawBody, "invoke_name")?.trim() ?? "unknown"
  const id = attributeValue(attributes, "id") ?? simpleTagValue(rawBody, "id")?.trim() ?? `call_text_${index}`
  const trimmedBody = rawBody.trim()
  if (trimmedBody.startsWith("{")) {
    const parsed = parseProviderToolArguments(trimmedBody, name, id)
    return { id, name, input: parsed.input, rawArguments: trimmedBody }
  }
  const argumentsText = parseSingularToolCallArguments(name, rawBody)
  const parsed = parseProviderToolArguments(argumentsText, name, id)
  return { id, name, input: parsed.input, rawArguments: argumentsText }
}

function parseSingularToolCallArguments(name: string, rawBody: string): string {
  const argsBody = simpleTagValue(rawBody, "args")
  const params = parseSimpleXmlArgumentTags(argsBody ?? rawBody, argsBody ? new Set() : new Set(["invoke_name", "id", "args"]))
  if (name === "bash" && typeof params.invoke === "string" && typeof params.command !== "string") {
    params.command = params.invoke
    delete params.invoke
  }
  return Object.keys(params).length > 0 ? JSON.stringify(params) : "{}"
}

function parseSimpleXmlArgumentTags(text: string, ignoredTags = new Set<string>()): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  const tagPattern = /<([a-zA-Z_][\w:-]*)>([\s\S]*?)<\/\1>/g
  for (const match of text.matchAll(tagPattern)) {
    const key = match[1] ?? ""
    const rawValue = match[2] ?? ""
    if (!key || ignoredTags.has(key)) continue
    params[key] = coerceSimpleTagValue(rawValue)
  }
  return params
}

function simpleTagValue(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))
  return match?.[1]
}

function parseAnthropicToolCalls(text: string): ProviderEvent[] {
  // Try <tool_calls> wrapper first, then bare <invoke> blocks
  const hasWrapper = toolCallsBlockPattern.test(text)
  toolCallsBlockPattern.lastIndex = 0

  if (hasWrapper) {
    return parseAnthropicWithWrapper(text)
  }

  // Bare <invoke> blocks without <tool_calls> wrapper
  return parseAnthropicBareInvokes(text)
}

function parseAnthropicWithWrapper(text: string): ProviderEvent[] {
  const events: ProviderEvent[] = []
  let cursor = 0
  let index = 0
  for (const blockMatch of text.matchAll(toolCallsBlockPattern)) {
    const start = blockMatch.index ?? 0
    const before = text.slice(cursor, start)
    if (before) events.push({ type: "text_delta", text: before })
    const blockContent = blockMatch[1] ?? ""
    for (const call of parseInvokeBlocks(blockContent, index)) {
      events.push({ type: "tool_call", call })
      index += 1
    }
    cursor = start + blockMatch[0].length
  }
  const tail = text.slice(cursor)
  if (tail) events.push({ type: "text_delta", text: tail })
  return events.filter((event) => event.type !== "text_delta" || event.text.length > 0)
}

function parseAnthropicBareInvokes(text: string): ProviderEvent[] {
  const events: ProviderEvent[] = []
  let cursor = 0
  let index = 0
  for (const match of text.matchAll(invokePattern)) {
    const start = match.index ?? 0
    const before = text.slice(cursor, start)
    if (before) events.push({ type: "text_delta", text: before })
    const name = match[1] ?? "unknown"
    const id = match[2] ?? `call_text_${index + 1}`
    const body = match[3] ?? ""
    const argumentsText = parseParametersToArguments(body)
    const parsed = parseProviderToolArguments(argumentsText, name, id)
    events.push({ type: "tool_call", call: { id, name, input: parsed.input, rawArguments: argumentsText } })
    index += 1
    cursor = start + match[0].length
  }
  const tail = text.slice(cursor)
  if (tail) events.push({ type: "text_delta", text: tail })
  return events.filter((event) => event.type !== "text_delta" || event.text.length > 0)
}

function parseInvokeBlocks(blockContent: string, startIndex: number): ToolCall[] {
  const calls: ToolCall[] = []
  let index = startIndex
  for (const match of blockContent.matchAll(invokePattern)) {
    index += 1
    const name = match[1] ?? "unknown"
    const id = match[2] ?? `call_text_${index}`
    const body = match[3] ?? ""
    const argumentsText = parseParametersToArguments(body)
    const parsed = parseProviderToolArguments(argumentsText, name, id)
    calls.push({ id, name, input: parsed.input, rawArguments: argumentsText })
  }
  return calls
}

function parseParametersToArguments(invokeBody: string): string {
  const params: Record<string, unknown> = {}
  for (const match of invokeBody.matchAll(parameterPattern)) {
    const key = match[1] ?? ""
    const attributes = match[2] ?? ""
    const rawValue = match[3] ?? ""
    if (!key) continue
    params[key] = attributeValue(attributes, "string") === "true" ? rawValue : coerceParameterValue(rawValue.trim())
  }
  return Object.keys(params).length > 0 ? JSON.stringify(params) : "{}"
}

function coerceParameterValue(value: string): unknown {
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value)
  return value
}

function coerceSimpleTagValue(rawValue: string): unknown {
  const trimmed = rawValue.trim()
  if (trimmed !== rawValue && /[\r\n]|^\s|\s$/.test(rawValue)) return rawValue
  return coerceParameterValue(trimmed)
}

const openTagRegex = /^<(?:[|｜]{2}DSML[|｜]{2})?(easycode_tool_call|tool_call|tool_calls|invoke)\b/i

const targetPrefixes = [
  "<easycode_tool_call",
  "<tool_call",
  "<tool_calls",
  "<invoke",
  "<||dsml||tool_calls",
  "<||dsml||invoke",
  "<||dsml||",
  "<｜｜dsml｜｜tool_calls",
  "<｜｜dsml｜｜invoke",
  "<｜｜dsml｜｜"
]

function isPartialOpenTag(str: string): boolean {
  const lower = str.toLowerCase()
  return targetPrefixes.some(p => p.startsWith(lower))
}

export class StreamXmlFilter {
  private buffer = ""

  feed(chunk: string): string {
    this.buffer += chunk
    let safeText = ""

    while (true) {
      const openIndex = this.buffer.indexOf("<")
      if (openIndex === -1) {
        safeText += this.buffer
        this.buffer = ""
        break
      }

      if (openIndex > 0) {
        safeText += this.buffer.slice(0, openIndex)
        this.buffer = this.buffer.slice(openIndex)
      }

      const match = this.buffer.match(openTagRegex)
      if (match) {
        const matchedOpening = match[1].toLowerCase()
        let closeRegex: RegExp
        if (matchedOpening === "easycode_tool_call") {
          closeRegex = /<\/easycode_tool_call>/i
        } else if (matchedOpening === "tool_call") {
          closeRegex = /<\/tool_call>/i
        } else if (matchedOpening === "tool_calls") {
          closeRegex = /<\/(?:[|｜]{2}DSML[|｜]{2})?tool_calls>/i
        } else {
          closeRegex = /<\/(?:[|｜]{2}DSML[|｜]{2})?invoke>/i
        }

        const closeMatch = this.buffer.match(closeRegex)
        if (closeMatch) {
          const closeIndex = closeMatch.index!
          const closeLen = closeMatch[0].length
          this.buffer = this.buffer.slice(closeIndex + closeLen)
          continue
        } else {
          break
        }
      }

      if (isPartialOpenTag(this.buffer)) {
        break
      }

      safeText += "<"
      this.buffer = this.buffer.slice(1)
    }

    return safeText
  }

  flush(): string {
    const leftover = this.buffer
    this.buffer = ""
    return leftover
  }
}
