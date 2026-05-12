import { DeepSeekProvider } from "./deepseek"
import { FakeProvider } from "./fake"
import { OpenAIProvider } from "./openai"
import type { Provider } from "./types"

export type ProviderFactory = () => Provider
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

export function createProvider(name: ProviderName) {
  const factory = providers.get(name)
  if (!factory) throw new Error(`Unknown provider: ${name}`)
  return factory()
}

registerProvider("fake", () => new FakeProvider())
registerProvider("openai", () => new OpenAIProvider())
registerProvider("deepseek", () => new DeepSeekProvider())
