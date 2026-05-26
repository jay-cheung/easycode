import { DeepSeekProvider } from "./deepseek"
import { FakeProvider } from "./fake"
import { OpenAICompatibleProvider } from "./openai-compatible"
import { OpenAIProvider } from "./openai"
import type { Provider, ProviderOptions } from "./types"

export type ProviderFactory = (options?: ProviderOptions) => Provider
export type ProviderName = string

const providers = new Map<ProviderName, ProviderFactory>()

export function registerProvider(name: ProviderName, factory: ProviderFactory) {
  if (providers.has(name)) throw new Error(`Provider already registered: ${name}`)
  providers.set(name, factory)
}

export function hasProvider(name: string | undefined): name is ProviderName {
  return Boolean(name && providers.has(name))
}

export function listProviders() {
  return [...providers.keys()].sort((left, right) => left.localeCompare(right))
}

export function createProvider(name: ProviderName, options?: ProviderOptions) {
  const factory = providers.get(name)
  if (!factory) throw new Error(`Unknown provider: ${name}`)
  return factory(options)
}

registerProvider("fake", (options) => new FakeProvider(options))
registerProvider("openai", (options) => new OpenAIProvider(options?.model, options))
registerProvider("deepseek", (options) => new DeepSeekProvider(options?.model, options))
registerProvider("openai-compatible", (options) => new OpenAICompatibleProvider(options?.model, options))
