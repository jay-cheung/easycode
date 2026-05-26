import { ChatCompletionsLikeProvider, chatCompletionSSEToProviderEvents, createChatCompletionStreamParseState } from "./chat-completions-like"
import { normalizeModelName } from "./openai-like"
import type { ProviderInput, ProviderOptions } from "./types"

export { chatCompletionSSEToProviderEvents }
export const createDeepSeekStreamParseState = createChatCompletionStreamParseState

export class DeepSeekProvider extends ChatCompletionsLikeProvider {
  constructor(model = process.env.DEEPSEEK_MODEL ?? process.env.EASYCODE_MODEL ?? "deepseek-v4-pro", runtime: ProviderOptions = {}) {
    super({
      name: "deepseek",
      model: normalizeModelName(model),
      apiKeyEnv: "DEEPSEEK_API_KEY",
      url: process.env.DEEPSEEK_API_URL ?? "https://api.deepseek.com/chat/completions",
      runtime,
      capabilities: {
        apiStyle: "chat_completions",
        supportsImages: false,
        supportsThinking: true,
        supportsReasoningEffort: true,
        effortValues: ["high", "max"],
        supportsJsonObjectResponse: true,
        supportsMaxOutputTokens: true,
        promptCacheMode: "automatic",
        contextWindowTokens: numberFromEnv("DEEPSEEK_CONTEXT_WINDOW_TOKENS") ?? numberFromEnv("EASYCODE_CONTEXT_WINDOW_TOKENS"),
        promptCacheMinPrefixTokens: numberFromEnv("DEEPSEEK_PROMPT_CACHE_MIN_PREFIX_TOKENS") ?? numberFromEnv("EASYCODE_PROMPT_CACHE_MIN_PREFIX_TOKENS"),
      },
      missingApiKeyMessage: "DEEPSEEK_API_KEY is required for DeepSeekProvider",
      errorPrefix: "DeepSeek API failed",
    })
  }

  protected override requestBodyExtensions(_input: ProviderInput): Record<string, unknown> {
    const thinkingEnabled = this.runtime.thinking !== false
    return {
      thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
      ...(thinkingEnabled ? { reasoning_effort: deepSeekReasoningEffort(this.runtime.effort ?? (process.env.DEEPSEEK_REASONING_EFFORT === "high" ? "high" : "max")) } : {}),
    }
  }
}

function numberFromEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

function deepSeekReasoningEffort(effort: string) {
  return effort === "max" ? "max" : "high"
}
