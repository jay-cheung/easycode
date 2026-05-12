import { toolToResponseTool } from "./utils"
import { Provider, ProviderInput, ProviderEvent, ProviderError } from "./types"
import type { ProviderInputMessage } from "../message"

type OpenAIContentPart = {
  type?: string
  text?: string
}

type OpenAIOutputItem = {
  id?: string
  call_id?: string
  type?: string
  name?: string
  arguments?: string
  content?: OpenAIContentPart[]
}

type OpenAIStreamEvent = {
  type?: string
  delta?: string
  text?: string
  arguments?: string
  name?: string
  item_id?: string
  item?: OpenAIOutputItem
  part?: OpenAIContentPart
  error?: { type?: string; code?: string; message?: string; param?: string | null }
  response?: { usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string } }
}

type OpenAIStreamParseState = {
  textItemsWithDeltas: Set<string>
  emittedToolItems: Set<string>
  emittedFailure: boolean
}

export type OpenAILikeProviderOptions = {
  name: string
  model: string
  apiKeyEnv: string
  url: string
  missingApiKeyMessage?: string
  errorPrefix?: string
}

export function createOpenAIStreamParseState(): OpenAIStreamParseState {
  return { textItemsWithDeltas: new Set(), emittedToolItems: new Set(), emittedFailure: false }
}

export function normalizeModelName(model: string) {
  return model.trim().toLowerCase();
}

export function providerMessageToResponseInput(message: ProviderInputMessage) {
  const role = message.role === "tool" ? "user" : message.role
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }],
  }
}

export function openAIStreamEventToProviderEvents(parsed: OpenAIStreamEvent, state: OpenAIStreamParseState = createOpenAIStreamParseState()): ProviderEvent[] {
  const failure = failureFromStreamEvent(parsed, state)
  if (failure) return [failure]
  if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
    state.textItemsWithDeltas.add(parsed.item_id ?? "__unknown_text_item__")
    return [{ type: "text_delta", text: parsed.delta }]
  }
  if (parsed.type === "response.output_text.done" && typeof parsed.text === "string" && !state.textItemsWithDeltas.has(parsed.item_id ?? "__unknown_text_item__")) {
    return [{ type: "text_delta", text: parsed.text }]
  }
  if (parsed.type === "response.content_part.done" && parsed.part?.type === "output_text" && typeof parsed.part.text === "string" && !state.textItemsWithDeltas.has(parsed.item_id ?? "__unknown_text_item__")) {
    return [{ type: "text_delta", text: parsed.part.text }]
  }
  if (parsed.type === "response.output_item.done") {
    const events: ProviderEvent[] = []
    if (parsed.item?.type === "message") {
      const text = parsed.item.content?.filter((part) => part.type === "output_text" && typeof part.text === "string").map((part) => part.text).join("") ?? ""
      if (text && !state.textItemsWithDeltas.has(parsed.item.id ?? "__unknown_text_item__")) events.push({ type: "text_delta", text })
    }
    const toolCall = toolCallFromOutputItem(parsed.item, state)
    if (toolCall) events.push(toolCall)
    return events
  }
  if (parsed.type === "response.function_call_arguments.done" && parsed.name) {
    return [toolCallEvent(parsed.item_id ?? `call_${parsed.name}`, parsed.name, parsed.arguments ?? "{}", state)].filter((event): event is ProviderEvent => Boolean(event))
  }
  if (parsed.type === "response.completed") return [{ type: "usage", inputTokens: parsed.response?.usage?.input_tokens ?? 0, outputTokens: parsed.response?.usage?.output_tokens ?? 0 }]
  return []
}

export class OpenAILikeProvider implements Provider {
  readonly name: string
  readonly model: string
  private readonly apiKeyEnv: string
  private readonly url: string
  private readonly missingApiKeyMessage: string
  private readonly errorPrefix: string

  constructor(options: OpenAILikeProviderOptions) {
    this.name = options.name
    this.model = options.model
    this.apiKeyEnv = options.apiKeyEnv
    this.url = options.url
    this.missingApiKeyMessage = options.missingApiKeyMessage ?? `${options.apiKeyEnv} is required for ${options.name} provider`
    this.errorPrefix = options.errorPrefix ?? "OpenAI-like API failed"
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    const apiKey = process.env[this.apiKeyEnv]
    if (!apiKey) throw new ProviderError(this.missingApiKeyMessage)
    const body = this.buildRequestBody(input)
    yield { type: "request", request: { url: this.url, method: "POST", body } }
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!response.ok || !response.body) {
      const output = await response.text().catch(() => "")
      yield { type: "response", response: { url: this.url, status: response.status, ok: response.ok, headers: responseHeaders(response), body: output } }
      throw new ProviderError(`${this.errorPrefix}: ${response.status} ${output}`, { status: response.status, output })
    }
    yield { type: "response", response: { url: this.url, status: response.status, ok: response.ok, headers: responseHeaders(response) } }
    yield* this.readResponseEvents(response)
    yield { type: "done" }
  }

  protected buildRequestBody(input: ProviderInput): unknown {
    return {
      model: this.model,
      stream: true,
      input: input.providerMessages.map(providerMessageToResponseInput),
      tools: input.tools.map(toolToResponseTool),
    }
  }

  protected async *readResponseEvents(response: Response): AsyncIterable<ProviderEvent> {
    if (!response.body) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const parseState = createOpenAIStreamParseState()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) yield* providerEventsFromSSELine(line, parseState, true)
    }
    if (buffer) yield* providerEventsFromSSELine(buffer, parseState, true)
  }
}

function providerEventsFromSSELine(line: string, state: OpenAIStreamParseState, includeRaw = false) {
  const trimmed = line.trimEnd()
  if (!trimmed.startsWith("data: ")) return []
  const data = trimmed.slice(6).trim()
  if (data === "[DONE]") return []
  const parsed = JSON.parse(data) as OpenAIStreamEvent
  const events = openAIStreamEventToProviderEvents(parsed, state)
  return includeRaw ? [{ type: "response_raw", response: parsed } satisfies ProviderEvent, ...events] : events
}

function responseHeaders(response: Response) {
  return Object.fromEntries(response.headers.entries())
}

function toolCallFromOutputItem(item: OpenAIOutputItem | undefined, state: OpenAIStreamParseState) {
  if (item?.type !== "function_call" || !item.name) return undefined
  return toolCallEvent(item.call_id ?? item.id ?? `call_${item.name}`, item.name, item.arguments ?? "{}", state)
}

function toolCallEvent(id: string, name: string, rawArguments: string, state: OpenAIStreamParseState): ProviderEvent | undefined {
  if (state.emittedToolItems.has(id)) return undefined
  state.emittedToolItems.add(id)
  return { type: "tool_call", call: { id, name, input: JSON.parse(rawArguments) as unknown } }
}

function failureFromStreamEvent(parsed: OpenAIStreamEvent, state: OpenAIStreamParseState): ProviderEvent | undefined {
  if (state.emittedFailure) return undefined
  if (parsed.type === "error" && parsed.error?.message) {
    state.emittedFailure = true
    return { type: "failure", error: { message: parsed.error.message, code: parsed.error.code ?? parsed.error.type, output: JSON.stringify(parsed.error) } }
  }
  if (parsed.type === "response.failed" && parsed.response?.error?.message) {
    state.emittedFailure = true
    return { type: "failure", error: { message: parsed.response.error.message, code: parsed.response.error.code, output: JSON.stringify(parsed.response.error) } }
  }
  return undefined
}
