import type { WebSearchEngine } from "./retrieval"

export function selectEngine(engines: WebSearchEngine[], name: string | undefined) {
  if (!name) return undefined
  return engines.find((engine) => engine.name === name)
}

export function withImplicitDefaults<T extends { defaultEngine?: string; engines: WebSearchEngine[] }>(
  config: T,
  env: Record<string, string | undefined>,
  parseEngine: (input: unknown) => WebSearchEngine,
): T {
  const tavilyConfigured = Boolean(env.TAVILY_API_KEY)
  const existingTavily = config.engines.find((engine) => engine.name === "tavily")
  const engines = [...config.engines]
  if (!existingTavily && tavilyConfigured) {
    engines.push(parseEngine({
      name: "tavily",
      type: "tavily",
      apiKeyEnv: "TAVILY_API_KEY",
    }))
  }
  return {
    ...config,
    defaultEngine: config.defaultEngine ?? (engines.some((engine) => engine.name === "tavily") ? "tavily" : undefined),
    engines,
  } as T
}
