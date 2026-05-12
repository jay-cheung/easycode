import { OpenAILikeProvider, normalizeModelName } from "./openai-like"
import type { ProviderEvent, ProviderInput } from "./types"
import { toolToResponseTool } from "./utils"

type DeepSeekMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

type DeepSeekChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null
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
      messages: input.providerMessages.map(chatMessageFromProviderMessage),
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: false,
      tools: input.tools.map(toolToChatCompletionTool),
    }
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
    for (const toolCall of message?.tool_calls ?? []) {
      if (!toolCall.function?.name) continue
      const parsedInput = parseToolArguments(toolCall.function.arguments ?? "{}", toolCall.function.name, toolCall.id)
      if (!parsedInput.ok) {
        yield { type: "failure", error: parsedInput.error }
        return
      }
      yield {
        type: "tool_call",
        call: {
          id: toolCall.id ?? `call_${toolCall.function.name}`,
          name: toolCall.function.name,
          input: parsedInput.input,
        },
      }
    }
    if (message?.content) yield { type: "text_delta", text: message.content }
    if (parsed.usage) yield { type: "usage", inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0 }
  }
}

function chatMessageFromProviderMessage(message: ProviderInput["providerMessages"][number]): DeepSeekMessage {
  const role = message.role === "system" || message.role === "assistant" ? message.role : "user"
  return { role, content: message.content }
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

function parseToolArguments(rawArguments: string, toolName: string, callID: string | undefined) {
  try {
    return { ok: true as const, input: JSON.parse(rawArguments) as unknown }
  } catch (error) {
    const message = `Invalid tool arguments from provider for ${toolName}: ${error instanceof Error ? error.message : String(error)}`
    return {
      ok: false as const,
      error: {
        code: "invalid_tool_arguments",
        message,
        output: JSON.stringify({ code: "invalid_tool_arguments", message, tool: toolName, callID, arguments: rawArguments }),
      },
    }
  }
}
