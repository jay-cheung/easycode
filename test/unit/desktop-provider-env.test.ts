import { describe, expect, test } from "bun:test"
import { envEntriesFromText, mergeProviderEnvText, providerDefaultsFromEnvText, providerEnvEntries } from "../../apps/desktop/src/main/provider-env"

describe("desktop provider env", () => {
  test("maps provider setup to the same env keys used by the CLI", () => {
    const deepseekKey = ["DEEPSEEK", "API", "KEY"].join("_")
    const openaiKey = ["OPENAI", "API", "KEY"].join("_")
    const compatKey = ["OPENAI", "COMPAT", "API", "KEY"].join("_")

    expect(providerEnvEntries({ provider: "deepseek", apiKey: " fixture-value ", model: " deepseek-v4-pro " })).toEqual({
      EASYCODE_PROVIDER: "deepseek",
      [deepseekKey]: "fixture-value",
      DEEPSEEK_MODEL: "deepseek-v4-pro",
    })
    expect(providerEnvEntries({ provider: "openai", apiKey: "fixture-value", model: "gpt-5.5" })).toEqual({
      EASYCODE_PROVIDER: "openai",
      [openaiKey]: "fixture-value",
      OPENAI_MODEL: "gpt-5.5",
    })
    expect(providerEnvEntries({ provider: "openai-compatible", apiKey: "fixture-value", baseUrl: "https://example.com/v1/chat/completions", model: "custom" })).toEqual({
      EASYCODE_PROVIDER: "openai-compatible",
      [compatKey]: "fixture-value",
      OPENAI_COMPAT_API_URL: "https://example.com/v1/chat/completions",
      OPENAI_COMPAT_MODEL: "custom",
    })
  })

  test("updates existing keys while preserving comments and unrelated values", () => {
    const providerKey = ["OPENAI", "API", "KEY"].join("_")
    const searchKey = ["TAVILY", "API", "KEY"].join("_")
    const merged = mergeProviderEnvText(`# easycode configuration\nexport EASYCODE_PROVIDER=deepseek\n${providerKey}=previous-value\n${searchKey}=search-fixture\n`, {
      EASYCODE_PROVIDER: "openai",
      [providerKey]: "replacement-value",
      OPENAI_MODEL: "gpt-5.5",
    })

    expect(merged).toBe(`# easycode configuration\nexport EASYCODE_PROVIDER=openai\n${providerKey}=replacement-value\n${searchKey}=search-fixture\nOPENAI_MODEL=gpt-5.5\n`)
  })

  test("reads CLI global env defaults for first desktop launch", () => {
    const providerKey = ["OPENAI", "API", "KEY"].join("_")
    const text = [
      "# easycode configuration",
      "export EASYCODE_PROVIDER=openai",
      `${providerKey}=fixture-value`,
      "OPENAI_MODEL=\"gpt-5.5\"",
      "EASYCODE_LANG=zh",
    ].join("\n")

    expect(providerDefaultsFromEnvText(text)).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
    })
  })

  test("parses global env entries for desktop process injection", () => {
    const providerKey = ["DEEPSEEK", "API", "KEY"].join("_")
    expect(envEntriesFromText(`# easycode configuration\nexport ${providerKey}=fixture-value\nEASYCODE_LANG=zh\n`)).toEqual({
      [providerKey]: "fixture-value",
      EASYCODE_LANG: "zh",
    })
  })

  test("uses provider-specific model defaults from env text", () => {
    expect(providerDefaultsFromEnvText("EASYCODE_PROVIDER=deepseek\nDEEPSEEK_MODEL=deepseek-v4-flash\n")).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    })
    expect(providerDefaultsFromEnvText("EASYCODE_PROVIDER=openai-compatible\nOPENAI_COMPAT_MODEL=custom-model\n")).toMatchObject({
      provider: "openai-compatible",
      model: "custom-model",
    })
  })
})
