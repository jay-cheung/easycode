import { describe, expect, test } from "bun:test"
import { DeepSeekProvider, OpenAICompatibleProvider, OpenAIProvider } from "../../src/provider"
import { clampSubagentRoute, resolveSubagentRoute } from "../../src/agent/subagent-routing"
import { defaultSessionSettings } from "../../src/settings"

describe("subagent routing", () => {
  test("resolves OpenAI roles to expected thinking and effort", () => {
    const provider = new OpenAIProvider("gpt-5-mini")
    const settings = defaultSessionSettings("openai")

    expect(resolveSubagentRoute({ role: "explorer", provider: "openai", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "explorer",
      thinking: false,
      effort: undefined,
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "summary", provider: "openai", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "summary",
      model: "gpt-5-mini",
      thinking: true,
      effort: "low",
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "reviewer", provider: "openai", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "reviewer",
      thinking: true,
      effort: "medium",
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "debugger", provider: "openai", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "debugger",
      thinking: true,
      effort: "high",
      maxProviderCalls: 3,
    })
    expect(resolveSubagentRoute({ role: "tester", provider: "openai", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "tester",
      thinking: false,
      effort: undefined,
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "docs_researcher", provider: "openai", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "docs_researcher",
      thinking: false,
      effort: undefined,
      maxProviderCalls: 2,
    })
  })

  test("resolves DeepSeek roles to expected thinking and effort", () => {
    const provider = new DeepSeekProvider("deepseek-v4-pro")
    const settings = defaultSessionSettings("deepseek")

    expect(resolveSubagentRoute({ role: "tester", provider: "deepseek", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "tester",
      thinking: false,
      effort: undefined,
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "summary", provider: "deepseek", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "summary",
      model: "deepseek-v4-flash",
      thinking: true,
      effort: "high",
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "reviewer", provider: "deepseek", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "reviewer",
      thinking: true,
      effort: "high",
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "debugger", provider: "deepseek", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "debugger",
      thinking: true,
      effort: "max",
      maxProviderCalls: 3,
    })
    expect(resolveSubagentRoute({ role: "explorer", provider: "deepseek", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "explorer",
      thinking: false,
      effort: undefined,
      maxProviderCalls: 2,
    })
    expect(resolveSubagentRoute({ role: "docs_researcher", provider: "deepseek", model: provider.model, capabilities: provider.capabilities, settings })).toMatchObject({
      role: "docs_researcher",
      thinking: false,
      effort: undefined,
      maxProviderCalls: 2,
    })
  })

  test("providers without reasoning support clamp to thinking false", () => {
    const provider = new OpenAICompatibleProvider("qwen-coder")
    const settings = defaultSessionSettings("openai-compatible")

    expect(resolveSubagentRoute({ role: "reviewer", provider: "openai-compatible", model: provider.model, capabilities: provider.capabilities, settings, maxOutputTokens: 256 })).toMatchObject({
      thinking: false,
      effort: undefined,
      maxOutputTokens: 256,
    })
  })

  test("falls back to session provider and model when route inputs omit them", () => {
    const settings = {
      ...defaultSessionSettings("openai"),
      model: "gpt-5-mini",
    }
    const provider = new OpenAIProvider(settings.model)

    expect(resolveSubagentRoute({
      role: "summary",
      capabilities: provider.capabilities,
      settings,
    })).toMatchObject({
      provider: "openai",
      model: "gpt-5-mini",
      thinking: true,
      effort: "low",
    })
  })

  test("unsupported effort is clamped safely", () => {
    const provider = new DeepSeekProvider("deepseek-v4-pro")
    const route = clampSubagentRoute({
      role: "debugger",
      provider: "deepseek",
      model: provider.model,
      thinking: true,
      effort: "medium",
      maxProviderCalls: 3,
      maxOutputTokens: 512,
    }, provider.capabilities)

    expect(route).toMatchObject({
      thinking: true,
      effort: "high",
      maxProviderCalls: 3,
      maxOutputTokens: 512,
    })
  })
})
