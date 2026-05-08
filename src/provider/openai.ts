import { toolToResponseTool } from "./utils"
import { Provider, ProviderInput, ProviderEvent, ProviderError } from "./types"
import type { ProviderInputMessage } from "../message"

export function normalizeOpenAIModel(model: string) {
  return model.trim().replace(/^GPT/i, "gpt").replace(/^O(?=\d)/, "o")
}

export function providerMessageToResponseInput(message: ProviderInputMessage) {
  const role = message.role === "tool" ? "user" : message.role
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }],
  }
}

export class OpenAIProvider implements Provider {
  readonly name = "openai"
  readonly model: string

  constructor(model = process.env.EASYCODE_MODEL ?? "gpt-5-mini") {
    this.model = normalizeOpenAIModel(model)
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new ProviderError("OPENAI_API_KEY is required for OpenAIProvider")
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        input: input.providerMessages.map(providerMessageToResponseInput),
        tools: input.tools.map(toolToResponseTool),
      }),
    })
    if (!response.ok || !response.body) throw new ProviderError(`Responses API failed: ${response.status} ${await response.text().catch(() => "")}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (data === "[DONE]") continue
        const parsed = JSON.parse(data) as { type?: string; delta?: string; item?: { type?: string; name?: string; arguments?: string; call_id?: string }; response?: { usage?: { input_tokens?: number; output_tokens?: number } } }
        if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") yield { type: "text_delta", text: parsed.delta }
        if (parsed.type === "response.output_item.done" && parsed.item?.type === "function_call" && parsed.item.name) {
          yield { type: "tool_call", call: { id: parsed.item.call_id ?? `call_${parsed.item.name}`, name: parsed.item.name, input: JSON.parse(parsed.item.arguments ?? "{}") as unknown } }
        }
        if (parsed.type === "response.completed") yield { type: "usage", inputTokens: parsed.response?.usage?.input_tokens ?? 0, outputTokens: parsed.response?.usage?.output_tokens ?? 0 }
      }
    }
    yield { type: "done" }
  }
}
