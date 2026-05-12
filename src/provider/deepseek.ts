import { OpenAILikeProvider, normalizeModelName } from "./openai-like"
import type { ProviderEvent, ProviderInput } from "./types"
import { toolToResponseTool } from "./utils"
import { partToText, type ToolCallPart, type ToolResultPart } from "../message"
import { parseProviderToolArguments } from "../tool/utils/arguments"

type DeepSeekMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; reasoning_content?: string; tool_calls?: DeepSeekRequestToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

type DeepSeekRequestToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type DeepSeekChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
  error?: {
    code?: string
    message?: string
    type?: string
  }
}

export class DeepSeekProvider extends OpenAILikeProvider {
  constructor(model = process.env.DEEPSEEK_MODEL ?? process.env.EASYCODE_MODEL ?? "deepseek-v4-pro") {
    super({
      name: "deepseek",
      model: normalizeModelName(model),
      apiKeyEnv: "DEEPSEEK_API_KEY",
      url: process.env.DEEPSEEK_API_URL ?? "https://api.deepseek.com/chat/completions",
      missingApiKeyMessage: "DEEPSEEK_API_KEY is required for DeepSeekProvider",
      errorPrefix: "DeepSeek API failed",
    })
  }

  protected override buildRequestBody(input: ProviderInput) {
    return {
      model: this.model,
      messages: input.providerMessages.flatMap(chatMessagesFromProviderMessage),
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: false,
      tools: input.tools.map(toolToChatCompletionTool),
    }
  }

  protected override includeSuccessfulResponseBody() {
    return true
  }

  protected override async *readResponseEvents(response: Response): AsyncIterable<ProviderEvent> {
    const output = await response.text()
    const parsed = JSON.parse(output) as DeepSeekChatCompletion
    yield { type: "response_raw", response: parsed }
    if (parsed.error?.message) {
      yield { type: "failure", error: { message: parsed.error.message, code: parsed.error.code ?? parsed.error.type, output: JSON.stringify(parsed.error) } }
      return
    }
    const message = parsed.choices?.[0]?.message
    if (message?.reasoning_content) yield { type: "reasoning_delta", text: message.reasoning_content }
    for (const toolCall of message?.tool_calls ?? []) {
      if (!toolCall.function?.name) continue
      const parsedInput = parseProviderToolArguments(toolCall.function.arguments ?? "{}", toolCall.function.name, toolCall.id)
      yield {
        type: "tool_call",
        call: {
          id: toolCall.id ?? `call_${toolCall.function.name}`,
          name: toolCall.function.name,
          input: parsedInput.input,
          rawArguments: toolCall.function.arguments ?? "{}",
          reasoningContent: message?.reasoning_content ?? undefined,
        },
      }
    }
    if (message?.content) yield { type: "text_delta", text: message.content }
    if (parsed.usage) yield { type: "usage", inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0 }
  }
}

function chatMessagesFromProviderMessage(message: ProviderInput["providerMessages"][number]): DeepSeekMessage[] {
  const parts = message.parts ?? []
  const toolCalls = parts.filter((part): part is ToolCallPart => part.type === "tool_call")
  if (message.role === "assistant" && toolCalls.length > 0) {
    const text = parts.filter((part) => part.type !== "tool_call").map((part) => partToText(part)).join("\n")
    const reasoningContent = toolCalls.find((part) => part.call.reasoningContent)?.call.reasoningContent
    return [
      {
        role: "assistant",
        content: text || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        tool_calls: toolCalls.map((part) => ({
          id: part.call.id,
          type: "function",
          function: { name: part.call.name, arguments: part.call.rawArguments ?? JSON.stringify(part.call.input) },
        })),
      },
    ]
  }
  const toolResults = parts.filter((part): part is ToolResultPart => part.type === "tool_result")
  if (message.role === "tool" && toolResults.length > 0) {
    return toolResults.map((part) => ({ role: "tool", tool_call_id: part.callID, content: toolResultContent(part) }))
  }
  const role = message.role === "system" || message.role === "assistant" ? message.role : "user"
  return [{ role, content: message.content }]
}

function toolResultContent(part: ToolResultPart) {
  if (part.status === "succeeded") return part.output
  return `status: ${part.status}\n${part.output}`
}

function toolToChatCompletionTool(tool: Parameters<typeof toolToResponseTool>[0]) {
  const responseTool = toolToResponseTool(tool)
  return {
    type: "function",
    function: {
      name: responseTool.name,
      description: responseTool.description,
      parameters: responseTool.parameters,
      strict: responseTool.strict,
    },
  }
}
