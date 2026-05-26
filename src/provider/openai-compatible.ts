import { ChatCompletionsLikeProvider } from "./chat-completions-like"
import { normalizeModelName } from "./openai-like"
import type { ProviderOptions } from "./types"

export class OpenAICompatibleProvider extends ChatCompletionsLikeProvider {
  constructor(model = process.env.OPENAI_COMPAT_MODEL ?? process.env.EASYCODE_MODEL ?? "openai-compatible", runtime: ProviderOptions = {}) {
    super({
      name: "openai-compatible",
      model: normalizeModelName(model),
      apiKeyEnv: "OPENAI_COMPAT_API_KEY",
      url: process.env.OPENAI_COMPAT_API_URL ?? "https://api.openai.com/v1/chat/completions",
      runtime,
      capabilities: {
        apiStyle: "chat_completions",
        supportsImages: false,
        supportsThinking: false,
        supportsReasoningEffort: false,
        effortValues: [],
        supportsJsonObjectResponse: true,
        supportsMaxOutputTokens: true,
        promptCacheMode: "reported",
        contextWindowTokens: numberFromEnv("OPENAI_COMPAT_CONTEXT_WINDOW_TOKENS") ?? numberFromEnv("EASYCODE_CONTEXT_WINDOW_TOKENS"),
        promptCacheMinPrefixTokens: numberFromEnv("OPENAI_COMPAT_PROMPT_CACHE_MIN_PREFIX_TOKENS") ?? numberFromEnv("EASYCODE_PROMPT_CACHE_MIN_PREFIX_TOKENS"),
      },
      missingApiKeyMessage: "OPENAI_COMPAT_API_KEY is required for openai-compatible provider",
      errorPrefix: "OpenAI-compatible API failed",
    })
  }
}

function numberFromEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}
