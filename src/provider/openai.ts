export { createOpenAIStreamParseState, normalizeModelName, openAIStreamEventToProviderEvents, providerMessageToResponseInput } from "./openai-like"
import { OpenAILikeProvider, normalizeModelName } from "./openai-like"
import type { ProviderOptions } from "./types"

export class OpenAIProvider extends OpenAILikeProvider {
  constructor(model = process.env.EASYCODE_MODEL ?? "gpt-5-mini", runtime: ProviderOptions = {}) {
    super({
      name: "openai",
      model: normalizeModelName(model),
      apiKeyEnv: "OPENAI_API_KEY",
      url: process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/responses",
      runtime: {
        ...runtime,
        promptCacheKey: runtime.promptCacheKey ?? process.env.EASYCODE_PROMPT_CACHE_KEY ?? process.env.OPENAI_PROMPT_CACHE_KEY,
        promptCacheRetention: runtime.promptCacheRetention ?? promptCacheRetentionFromEnv(),
      },
      capabilities: { supportsImages: true, supportsThinking: true, supportsReasoningEffort: true, effortValues: ["low", "medium", "high"] },
      missingApiKeyMessage: "OPENAI_API_KEY is required for OpenAIProvider",
      errorPrefix: "Responses API failed",
    })
  }
}

function promptCacheRetentionFromEnv(): ProviderOptions["promptCacheRetention"] {
  const value = process.env.EASYCODE_PROMPT_CACHE_RETENTION ?? process.env.OPENAI_PROMPT_CACHE_RETENTION
  return value === "in_memory" || value === "24h" ? value : undefined
}
