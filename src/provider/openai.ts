export { createOpenAIStreamParseState, normalizeModelName, openAIStreamEventToProviderEvents, providerMessageToResponseInput } from "./openai-like"
import { OpenAILikeProvider, normalizeModelName } from "./openai-like"
import type { ProviderOptions } from "./types"

export class OpenAIProvider extends OpenAILikeProvider {
  constructor(model = process.env.OPENAI_MODEL ?? process.env.EASYCODE_MODEL ?? "gpt-5-mini", runtime: ProviderOptions = {}) {
    const normalizedModel = normalizeModelName(model)
    const reasoningModel = isReasoningModel(normalizedModel)
    super({
      name: "openai",
      model: normalizedModel,
      apiKeyEnv: "OPENAI_API_KEY",
      url: process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/responses",
      runtime: {
        ...runtime,
        promptCacheKey: runtime.promptCacheKey ?? process.env.EASYCODE_PROMPT_CACHE_KEY ?? process.env.OPENAI_PROMPT_CACHE_KEY,
        promptCacheRetention: runtime.promptCacheRetention ?? promptCacheRetentionFromEnv(),
      },
      capabilities: { apiStyle: "responses", supportsImages: true, supportsThinking: reasoningModel, supportsReasoningEffort: reasoningModel, effortValues: reasoningModel ? ["low", "medium", "high"] : [], supportsJsonObjectResponse: true, supportsMaxOutputTokens: true, promptCacheMode: "explicit", contextWindowTokens: numberFromEnv("OPENAI_CONTEXT_WINDOW_TOKENS") ?? numberFromEnv("EASYCODE_CONTEXT_WINDOW_TOKENS"), promptCacheMinPrefixTokens: numberFromEnv("OPENAI_PROMPT_CACHE_MIN_PREFIX_TOKENS") ?? numberFromEnv("EASYCODE_PROMPT_CACHE_MIN_PREFIX_TOKENS") },
      missingApiKeyMessage: "OPENAI_API_KEY is required for OpenAIProvider",
      errorPrefix: "Responses API failed",
    })
  }
}

function isReasoningModel(model: string): boolean {
  return model.startsWith("gpt-5") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")
}

function numberFromEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

function promptCacheRetentionFromEnv(): ProviderOptions["promptCacheRetention"] {
  const value = process.env.EASYCODE_PROMPT_CACHE_RETENTION ?? process.env.OPENAI_PROMPT_CACHE_RETENTION
  return value === "in_memory" || value === "24h" ? value : undefined
}
