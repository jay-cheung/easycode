import { Provider, ProviderError, ProviderEvent, ProviderInput } from "./types"
import type { ProviderCapabilities, ProviderOptions } from "./types"
import { getTlsConfig } from "../tls-config"

export type HttpSSEProviderOptions = {
  name: string
  model: string
  apiKeyEnv: string
  url: string
  capabilities: ProviderCapabilities
  runtime?: ProviderOptions
  missingApiKeyMessage?: string
  errorPrefix?: string
}

export abstract class HttpSSEProviderBase<TState = unknown> implements Provider {
  readonly name: string
  readonly model: string
  readonly capabilities: ProviderCapabilities
  private readonly apiKeyEnv: string
  private readonly url: string
  protected readonly runtime: ProviderOptions
  private readonly missingApiKeyMessage: string
  private readonly errorPrefix: string

  constructor(options: HttpSSEProviderOptions) {
    this.name = options.name
    this.model = options.model
    this.capabilities = options.capabilities
    this.apiKeyEnv = options.apiKeyEnv
    this.url = options.url
    this.runtime = options.runtime ?? {}
    this.missingApiKeyMessage = options.missingApiKeyMessage ?? `${options.apiKeyEnv} is required for ${options.name} provider`
    this.errorPrefix = options.errorPrefix ?? `${options.name} API failed`
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    this.validateInput(input)
    const apiKey = process.env[this.apiKeyEnv]
    if (!apiKey) throw new ProviderError(this.missingApiKeyMessage)
    const body = this.buildRequestBody(input)
    yield { type: "request", request: { url: this.url, method: "POST", body } }

    const tlsConfig = getTlsConfig()
    const fetchOptions: RequestInit & { tls?: unknown } = {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: input.signal,
    }
    if (tlsConfig) {
      fetchOptions.tls = tlsConfig
    }

    let response: Response
    try {
      response = await fetch(this.url, fetchOptions)
    } catch (error) {
      const detail = formatFetchFailure(error)
      throw new ProviderError(`${this.errorPrefix}: ${detail}`, { output: detail })
    }
    if (!response.ok || !response.body) {
      const output = await response.text().catch(() => "")
      yield { type: "response", response: { url: this.url, status: response.status, ok: response.ok, headers: responseHeaders(response), body: output } }
      throw new ProviderError(`${this.errorPrefix}: ${response.status} ${output}`, { status: response.status, output })
    }
    yield { type: "response", response: { url: this.url, status: response.status, ok: response.ok, headers: responseHeaders(response), ...(await this.successfulResponseBody(response)) } }
    yield* this.readResponseEvents(response)
    yield { type: "done" }
  }

  protected validateInput(_input: ProviderInput) {
    // Provider-specific adapters can reject unsupported input before network I/O.
  }

  protected abstract buildRequestBody(input: ProviderInput): unknown
  protected abstract createStreamParseState(): TState
  protected abstract eventsFromSSELine(line: string, state: TState, includeRaw: boolean): ProviderEvent[]

  protected async *readResponseEvents(response: Response): AsyncIterable<ProviderEvent> {
    if (!response.body) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = this.createStreamParseState()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) yield* this.eventsFromSSELine(line, state, true)
    }
    if (buffer) yield* this.eventsFromSSELine(buffer, state, true)
  }

  protected includeSuccessfulResponseBody() {
    return false
  }

  private async successfulResponseBody(response: Response) {
    if (!this.includeSuccessfulResponseBody()) return {}
    return { body: await response.clone().text().catch(() => "") }
  }
}

export function responseHeaders(response: Response) {
  return Object.fromEntries(response.headers.entries())
}

function formatFetchFailure(error: unknown) {
  const messages = collectErrorMessages(error)
  if (messages.length === 0) return "network request failed"
  if (messages.length === 1) return messages[0]
  return `${messages[0]} (cause: ${messages.slice(1).join("; ")})`
}

function collectErrorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || seen.has(error)) return []
  seen.add(error)

  if (error instanceof Error) {
    const ownMessage = typeof error.message === "string" ? error.message.trim() : ""
    const causeMessages = "cause" in error ? collectErrorMessages((error as Error & { cause?: unknown }).cause, seen) : []
    return uniqueNonEmpty([ownMessage, ...causeMessages])
  }

  if (typeof error === "string") return error.trim() ? [error.trim()] : []
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return [message.trim()]
  }
  return [String(error)]
}

function uniqueNonEmpty(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}
