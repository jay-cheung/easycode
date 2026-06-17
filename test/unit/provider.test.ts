import { afterEach, describe, expect, test } from "bun:test"
import { chatCompletionSSEToProviderEvents, ChatCompletionsLikeProvider, createDeepSeekStreamParseState, createOpenAIStreamParseState, createProvider, DeepSeekProvider, diagnoseProviderReadiness, FakeProvider, hasProvider, listProviders, missingProviderEnv, OpenAICompatibleProvider, OpenAILikeProvider, OpenAIProvider, ResponsesProvider, StreamXmlFilter, TextToolProtocolProvider, normalizeModelName, openAIStreamEventToProviderEvents, providerMessageToResponseInput, registerProvider, requiredProviderEnv, textToolProtocolInput, textToolProtocolOutputToProviderEvents, toolToChatCompletionTool, toolToResponseTool } from "../../src/provider"
import { createMessage, imagePart, messagesToProviderInput, reasoningPart, textMessage, textPart, toolCallMessage, toolResultMessage, userMessage } from "../../src/message"
import { createBuiltinRegistry } from "../../src/tool"
import type { Provider, ProviderEvent } from "../../src/provider"

describe("provider", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("fake provider emits deterministic tool calls", async () => {
    const provider = new FakeProvider()
    const events = []
    for await (const event of provider.stream({ mode: "build", prompt: "Fix the failing test", messages: [textMessage("user", "Fix")], providerMessages: [], tools: [] })) events.push(event)
    expect(events.some((event) => event.type === "tool_call")).toBe(true)
  })

  test("maps tools to Responses function schema", () => {
    const tool = createBuiltinRegistry().get("read")
    if (!tool) throw new Error("missing read tool")
    expect(toolToResponseTool(tool)).toMatchObject({ type: "function", name: "read", strict: true })
  })

  test("maps optional tool parameters to strict nullable schema", () => {
    const tool = createBuiltinRegistry().get("list")
    if (!tool) throw new Error("missing list tool")
    const responseTool = toolToResponseTool(tool)
    expect(responseTool.parameters.required).toEqual(["dirPath"])
    expect(responseTool.parameters.properties.dirPath.type).toEqual(["string", "null"])
  })

  test("maps chat-completions tools without Responses strict schema rewriting", () => {
    const tool = createBuiltinRegistry().get("list")
    if (!tool) throw new Error("missing list tool")
    const chatTool = toolToChatCompletionTool(tool)
    expect(chatTool).toMatchObject({ type: "function", function: { name: "list", parameters: tool.jsonSchema } })
    expect(chatTool.function).not.toHaveProperty("strict")
    expect(chatTool.function.parameters.required).toEqual([])
  })

  test("normalizes common OpenAI model display casing", () => {
    expect(normalizeModelName("GPT-5.4-mini")).toBe("gpt-5.4-mini")
    expect(normalizeModelName("O3")).toBe("o3")
    expect(new OpenAIProvider("GPT-5-mini").model).toBe("gpt-5-mini")
  })

  test("providers expose the expected adapter bases and capabilities", () => {
    const previousDeepSeekModel = process.env.DEEPSEEK_MODEL
    const previousEasyCodeModel = process.env.EASYCODE_MODEL
    delete process.env.DEEPSEEK_MODEL
    delete process.env.EASYCODE_MODEL
    try {
      expect(new OpenAIProvider("gpt-5-mini")).toBeInstanceOf(OpenAILikeProvider)
      expect(new OpenAIProvider("gpt-5-mini")).toBeInstanceOf(ResponsesProvider)
      expect(new DeepSeekProvider("deepseek-v4-pro")).toBeInstanceOf(ChatCompletionsLikeProvider)
      expect(new OpenAICompatibleProvider("qwen-coder")).toBeInstanceOf(ChatCompletionsLikeProvider)
      expect(new DeepSeekProvider().model).toBe("deepseek-v4-pro")
      expect(new DeepSeekProvider("deepseek-chat").model).toBe("deepseek-chat")
      expect(new OpenAIProvider("gpt-5-mini").capabilities).toMatchObject({ apiStyle: "responses", supportsThinking: true, supportsJsonObjectResponse: true, supportsMaxOutputTokens: true, promptCacheMode: "explicit" })
      expect(new DeepSeekProvider("deepseek-v4-pro").capabilities).toMatchObject({ apiStyle: "chat_completions", supportsImages: false, supportsThinking: true, supportsJsonObjectResponse: true, promptCacheMode: "automatic" })
      expect(new OpenAICompatibleProvider("qwen-coder").capabilities).toMatchObject({ apiStyle: "chat_completions", supportsThinking: false, supportsJsonObjectResponse: true, promptCacheMode: "reported" })
    } finally {
      if (previousDeepSeekModel === undefined) delete process.env.DEEPSEEK_MODEL
      else process.env.DEEPSEEK_MODEL = previousDeepSeekModel
      if (previousEasyCodeModel === undefined) delete process.env.EASYCODE_MODEL
      else process.env.EASYCODE_MODEL = previousEasyCodeModel
    }
  })

  test("provider registry creates registered providers", () => {
    expect(listProviders()).toContain("fake")
    expect(listProviders()).toContain("openai")
    expect(listProviders()).toContain("deepseek")
    expect(listProviders()).toContain("openai-compatible")
    expect(hasProvider("fake")).toBe(true)
    expect(createProvider("fake")).toBeInstanceOf(FakeProvider)
    expect(() => registerProvider("fake", () => new FakeProvider())).toThrow("Provider already registered")
    expect(() => createProvider("missing")).toThrow("Unknown provider")
  })

  test("provider readiness reports registration and environment diagnostics without streaming", () => {
    expect(requiredProviderEnv("openai-compatible")).toEqual(["OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_API_URL"])
    expect(missingProviderEnv("openai", {})).toEqual(["OPENAI_API_KEY"])

    expect(diagnoseProviderReadiness("fake", {})).toMatchObject({
      provider: "fake",
      status: "ready",
      registered: true,
      missingEnv: [],
      capabilities: { apiStyle: "local" },
    })
    expect(diagnoseProviderReadiness("openai", {})).toMatchObject({
      provider: "openai",
      status: "missing_env",
      registered: true,
      missingEnv: ["OPENAI_API_KEY"],
    })
    expect(diagnoseProviderReadiness("missing", {})).toMatchObject({
      provider: "missing",
      status: "unknown_provider",
      registered: false,
    })
  })

  test("maps assistant history to Responses output content", () => {
    expect(providerMessageToResponseInput({ role: "assistant", content: "done" })).toMatchObject([{ type: "message", role: "assistant", content: [{ type: "output_text" }] }])
    expect(providerMessageToResponseInput({ role: "user", content: "hi" })).toMatchObject([{ type: "message", role: "user", content: [{ type: "input_text" }] }])
    expect(providerMessageToResponseInput({ role: "tool", content: "result" })).toMatchObject([{ type: "message", role: "user", content: [{ type: "input_text", text: "result" }] }])
  })

  test("maps structured tool history to Responses items without XML fallback messages", () => {
    const input = messagesToProviderInput([
      toolCallMessage({ id: "call_1", name: "read", input: { filePath: "a.ts" } }),
      toolResultMessage({ callID: "call_1", toolName: "read", status: "succeeded", output: "ok" }),
    ])

    expect(input.flatMap(providerMessageToResponseInput)).toEqual([
      { type: "function_call", id: "call_1", call_id: "call_1", name: "read", arguments: "{\"filePath\":\"a.ts\"}" },
      { type: "function_call_output", call_id: "call_1", output: expect.stringContaining("excerpt:\nok") },
    ])
  })

  test("emits raw OpenAI request before fetch", async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const provider = new OpenAIProvider("o3-mini")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          url: "https://api.openai.com/v1/responses",
          method: "POST",
          body: {
            model: "o3-mini",
            stream: true,
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
            reasoning: { effort: "high" },
            tools: [],
            prompt_cache_key: expect.stringMatching(/^easycode-build-[a-f0-9]{16}$/),
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  test("maps image parts to OpenAI Responses input_image content", async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const provider = new OpenAIProvider("gpt-5-mini", { effort: "max" })
      const messages = messagesToProviderInput([userMessage("describe", [imagePart({ type: "url", url: "https://example.test/image.png" })])])
      const stream = provider.stream({ mode: "build", prompt: "describe", messages: [], providerMessages: messages, tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: "https://example.test/image.png" }] }],
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  test("allows explicit OpenAI prompt cache routing and retention", async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const provider = new OpenAIProvider("gpt-5-mini", { promptCacheKey: "project-cache-key", promptCacheRetention: "24h" })
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            prompt_cache_key: "project-cache-key",
            prompt_cache_retention: "24h",
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  test("adds OpenAI Responses JSON mode when requested", async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const provider = new OpenAIProvider("gpt-5-mini", { responseFormat: "json_object" })
      const stream = provider.stream({ mode: "build", prompt: "json", messages: [], providerMessages: [{ role: "user", content: "Return JSON." }], tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            text: { format: { type: "json_object" } },
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  test("rejects image input for DeepSeek before fetch", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const messages = messagesToProviderInput([userMessage("describe", [imagePart({ type: "url", url: "https://example.test/image.png" })])])
      let error: unknown
      try {
        for await (const _ of provider.stream({ mode: "build", prompt: "describe", messages: [], providerMessages: messages, tools: [] })) {
          // consume stream
        }
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect(String((error as Error).message)).toContain("does not support image input")
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("emits raw DeepSeek request before fetch", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const readTool = createBuiltinRegistry().get("read")
      if (!readTool) throw new Error("missing read tool")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [readTool] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          url: "https://api.deepseek.com/chat/completions",
          method: "POST",
          body: {
            model: "deepseek-v4-pro",
            messages: [{ role: "user", content: "hi" }],
            thinking: { type: "enabled" },
            reasoning_effort: "max",
            stream: true,
            stream_options: { include_usage: true },
          },
        },
      })
      expect((first.value as { request: { body: { tools: unknown[] } } }).request.body.tools[0]).toMatchObject({ type: "function", function: { name: "read" } })
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("wraps fetch failures into ProviderError and preserves nested TLS causes", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    globalThis.fetch = (async () => {
      const error = new Error("Unable to connect. Is the computer able to access the url?")
      ;(error as Error & { cause?: unknown }).cause = new Error("unable to get local issuer certificate")
      throw error
    }) as unknown as typeof fetch
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      expect(first.value).toMatchObject({ type: "request" })
      await expect(stream.next()).rejects.toThrow("Unable to connect. Is the computer able to access the url? (cause: unable to get local issuer certificate)")
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("passes Bun fetch verbose diagnostics only when requested", async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY
    const previousVerbose = process.env.EASYCODE_FETCH_VERBOSE
    const seenVerbose: unknown[] = []
    process.env.DEEPSEEK_API_KEY = "test-key"
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      seenVerbose.push((init as RequestInit & { verbose?: boolean }).verbose)
      throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()")
    }) as unknown as typeof fetch
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")

      delete process.env.EASYCODE_FETCH_VERBOSE
      let stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      await stream.next()
      await expect(stream.next()).rejects.toThrow("socket connection was closed unexpectedly")

      process.env.EASYCODE_FETCH_VERBOSE = "1"
      stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      await stream.next()
      await expect(stream.next()).rejects.toThrow("socket connection was closed unexpectedly")

      expect(seenVerbose).toEqual([undefined, true])
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
      if (previousVerbose === undefined) delete process.env.EASYCODE_FETCH_VERBOSE
      else process.env.EASYCODE_FETCH_VERBOSE = previousVerbose
    }
  })

  test("surfaces response body read failures in provider errors", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      body: null,
      headers: new Headers(),
      text: async () => {
        throw new Error("socket closed")
      },
    })) as unknown as typeof fetch
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      await stream.next()
      const response = await stream.next()
      expect(response.value).toMatchObject({
        type: "response",
        response: {
          status: 502,
          body: "[failed to read error response body: socket closed]",
        },
      })
      await expect(stream.next()).rejects.toThrow("502 [failed to read error response body: socket closed]")
    } finally {
      globalThis.fetch = originalFetch
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("adds DeepSeek JSON response format when requested", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro", { responseFormat: "json_object" })
      const stream = provider.stream({ mode: "build", prompt: "json", messages: [], providerMessages: [{ role: "user", content: "Return {\"ok\": true}" }], tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            response_format: { type: "json_object" },
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("adds DeepSeek max output tokens when requested", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro", { maxOutputTokens: 123 })
      const stream = provider.stream({ mode: "build", prompt: "short", messages: [], providerMessages: [{ role: "user", content: "short" }], tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            max_tokens: 123,
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("openai-compatible provider reuses chat completions payload without DeepSeek thinking fields", async () => {
    const previousKey = process.env.OPENAI_COMPAT_API_KEY
    const previousUrl = process.env.OPENAI_COMPAT_API_URL
    process.env.OPENAI_COMPAT_API_KEY = "test-key"
    process.env.OPENAI_COMPAT_API_URL = "https://compat.example.test/v1/chat/completions"
    try {
      const provider = new OpenAICompatibleProvider("qwen-coder", { responseFormat: "json_object", maxOutputTokens: 55 })
      const readTool = createBuiltinRegistry().get("read")
      if (!readTool) throw new Error("missing read tool")
      const stream = provider.stream({ mode: "build", prompt: "json", messages: [], providerMessages: [{ role: "user", content: "Return JSON." }], tools: [readTool] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          url: "https://compat.example.test/v1/chat/completions",
          body: {
            model: "qwen-coder",
            messages: [{ role: "user", content: "Return JSON." }],
            stream: true,
            stream_options: { include_usage: true },
            response_format: { type: "json_object" },
            max_tokens: 55,
          },
        },
      })
      expect((first.value as { request: { body: Record<string, unknown> } }).request.body.thinking).toBeUndefined()
      expect((first.value as { request: { body: Record<string, unknown> } }).request.body.reasoning_effort).toBeUndefined()
      expect((first.value as { request: { body: { tools: unknown[] } } }).request.body.tools[0]).toMatchObject({ type: "function", function: { name: "read" } })
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY
      else process.env.OPENAI_COMPAT_API_KEY = previousKey
      if (previousUrl === undefined) delete process.env.OPENAI_COMPAT_API_URL
      else process.env.OPENAI_COMPAT_API_URL = previousUrl
    }
  })

  test("maps structured tool history to DeepSeek chat messages", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const history = messagesToProviderInput([
        toolCallMessage({ id: "call_1", name: "list", input: { __easycodeInvalidToolArguments: true }, rawArguments: "{\"dirPath\": .}", reasoningContent: "I should inspect files." }),
        toolResultMessage({ callID: "call_1", toolName: "list", status: "succeeded", output: "README.md" }),
        textMessage("user", "继续"),
      ])
      const stream = provider.stream({ mode: "build", prompt: "继续", messages: [], providerMessages: history, tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            messages: [
              { role: "assistant", content: null, reasoning_content: "I should inspect files.", tool_calls: [{ id: "call_1", type: "function", function: { name: "list", arguments: "{\"dirPath\": .}" } }] },
              { role: "tool", tool_call_id: "call_1", content: expect.stringContaining("excerpt:\nREADME.md") },
              { role: "user", content: "继续" },
            ],
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("preserves full assistant reasoning history in DeepSeek thinking replay", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const reasoning = "r".repeat(3_000)
      const history = messagesToProviderInput([
        createMessage("assistant", [reasoningPart(reasoning), textPart("Need intraday data first.")]),
        textMessage("user", "继续"),
      ])
      const stream = provider.stream({ mode: "build", prompt: "继续", messages: [], providerMessages: history, tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            messages: [
              { role: "assistant", content: "Need intraday data first.", reasoning_content: reasoning },
              { role: "user", content: "继续" },
            ],
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("provides empty reasoning_content when thinking is enabled but reasoning is empty", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const history = messagesToProviderInput([
        toolCallMessage({ id: "call_1", name: "list", input: {}, rawArguments: "{\"dirPath\": .}" }),
        toolResultMessage({ callID: "call_1", toolName: "list", status: "succeeded", output: "README.md" }),
        createMessage("assistant", [textPart("done")]),
        textMessage("user", "继续"),
      ])
      const stream = provider.stream({ mode: "build", prompt: "继续", messages: [], providerMessages: history, tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          body: {
            messages: [
              { role: "assistant", content: null, reasoning_content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "list", arguments: "{\"dirPath\": .}" } }] },
              { role: "tool", tool_call_id: "call_1", content: expect.stringContaining("excerpt:\nREADME.md") },
              { role: "assistant", content: "done", reasoning_content: "" },
              { role: "user", content: "继续" },
            ],
          },
        },
      })
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  test("parses DeepSeek streamed chat completion response", async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY
    const previousFetch = globalThis.fetch
    process.env.DEEPSEEK_API_KEY = "test-key"
    globalThis.fetch = (async () =>
      sseResponse([
        { choices: [{ index: 0, delta: { content: "hel" } }] },
        { choices: [{ index: 0, delta: { content: "lo" } }] },
        { choices: [{ index: 0, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1, completion_tokens_details: { reasoning_tokens: 0 } } },
      ])) as unknown as typeof fetch
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      await stream.next()
      const response = await stream.next()
      const raw = await stream.next()
      const text = await stream.next()
      const raw2 = await stream.next()
      const text2 = await stream.next()
      const raw3 = await stream.next()
      const usage = await stream.next()
      expect(response.value).toMatchObject({ type: "response", response: { url: "https://api.deepseek.com/chat/completions", status: 200, ok: true } })
      expect((response.value as { response: { body?: string } }).response.body).toBeUndefined()
      expect(raw.value).toEqual({ type: "response_raw", response: { choices: [{ index: 0, delta: { content: "hel" } }] } })
      expect(text.value).toEqual({ type: "text_delta", text: "hel" })
      expect(raw2.value).toEqual({ type: "response_raw", response: { choices: [{ index: 0, delta: { content: "lo" } }] } })
      expect(text2.value).toEqual({ type: "text_delta", text: "lo" })
      expect(raw3.value).toEqual({ type: "response_raw", response: { choices: [{ index: 0, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1, completion_tokens_details: { reasoning_tokens: 0 } } } })
      expect(usage.value).toEqual({ type: "usage", inputTokens: 2, outputTokens: 3, cacheHitTokens: 1, cacheMissTokens: 1, totalTokens: 5, reasoningTokens: 0 })
      await stream.return?.()
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
    }
  })

  test("turns invalid DeepSeek tool arguments into a tool call for model feedback", async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY
    const previousFetch = globalThis.fetch
    process.env.DEEPSEEK_API_KEY = "test-key"
    globalThis.fetch = (async () =>
      sseResponse([
        { choices: [{ index: 0, delta: { reasoning_content: "Need " } }] },
        { choices: [{ index: 0, delta: { reasoning_content: "list.", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list", arguments: "{\"dir" } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "Path\": .}" } }] } }] },
        { choices: [{ index: 0, finish_reason: "tool_calls" }] },
      ])) as unknown as typeof fetch
    try {
      const provider = new DeepSeekProvider("deepseek-v4-pro")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      await stream.next()
      await stream.next()
      await stream.next()
      const reasoning = await stream.next()
      await stream.next()
      const reasoning2 = await stream.next()
      await stream.next()
      await stream.next()
      const toolCall = await stream.next()
      expect(reasoning.value).toEqual({ type: "reasoning_delta", text: "Need " })
      expect(reasoning2.value).toEqual({ type: "reasoning_delta", text: "list." })
      expect(toolCall.value).toMatchObject({ type: "tool_call", call: { id: "call_1", name: "list", rawArguments: "{\"dirPath\": .}", reasoningContent: "Need list.", input: { __easycodeInvalidToolArguments: true, arguments: "{\"dirPath\": .}" } } })
      await stream.return?.()
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
    }
  })

  test("emits raw OpenAI response before stream events", async () => {
    const previousKey = process.env.OPENAI_API_KEY
    const previousFetch = globalThis.fetch
    process.env.OPENAI_API_KEY = "test-key"
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"hello\"}\n\n"))
            controller.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_1" } },
      )) as unknown as typeof fetch
    try {
      const provider = new OpenAIProvider("gpt-5-mini")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      await stream.next()
      const response = await stream.next()
      const raw = await stream.next()
      const text = await stream.next()
      expect(response.value).toMatchObject({ type: "response", response: { url: "https://api.openai.com/v1/responses", status: 200, ok: true, headers: { "x-request-id": "req_1" } } })
      expect(raw.value).toEqual({ type: "response_raw", response: { type: "response.output_text.delta", item_id: "msg_1", delta: "hello" } })
      expect(text.value).toEqual({ type: "text_delta", text: "hello" })
      await stream.return?.()
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
    }
  })

  test("parses Responses text fallback events", () => {
    expect(openAIStreamEventToProviderEvents({ type: "response.output_text.done", item_id: "msg_1", text: "hello" })).toEqual([{ type: "text_delta", text: "hello" }])
    expect(openAIStreamEventToProviderEvents({ type: "response.content_part.done", item_id: "msg_2", part: { type: "output_text", text: "world" } })).toEqual([{ type: "text_delta", text: "world" }])
    expect(openAIStreamEventToProviderEvents({ type: "response.output_item.done", item: { id: "msg_3", type: "message", content: [{ type: "output_text", text: "done" }] } })).toEqual([{ type: "text_delta", text: "done" }])
  })

  test("does not duplicate done text after deltas", () => {
    const state = createOpenAIStreamParseState()
    expect(openAIStreamEventToProviderEvents({ type: "response.output_text.delta", item_id: "msg_1", delta: "he" }, state)).toEqual([{ type: "text_delta", text: "he" }])
    expect(openAIStreamEventToProviderEvents({ type: "response.output_text.done", item_id: "msg_1", text: "hello" }, state)).toEqual([])
    expect(openAIStreamEventToProviderEvents({ type: "response.output_item.done", item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "hello" }] } }, state)).toEqual([])
  })

  test("parses Responses function-call arguments done events", () => {
    expect(openAIStreamEventToProviderEvents({ type: "response.function_call_arguments.done", item_id: "call_1", name: "list", arguments: "{\"dirPath\":\".\"}" })).toEqual([{ type: "tool_call", call: { id: "call_1", name: "list", input: { dirPath: "." } } }])
    expect(openAIStreamEventToProviderEvents({ type: "response.output_item.done", item: { id: "item_1", call_id: "call_2", type: "function_call", name: "read", arguments: "{\"filePath\":\"README.md\"}" } })).toEqual([{ type: "tool_call", call: { id: "call_2", name: "read", input: { filePath: "README.md" } } }])
    expect(openAIStreamEventToProviderEvents({ type: "response.function_call_arguments.done", item_id: "call_3", name: "list", arguments: "{\"dirPath\": .}" })[0]).toMatchObject({
      type: "tool_call",
      call: { id: "call_3", name: "list", input: { __easycodeInvalidToolArguments: true, arguments: "{\"dirPath\": .}" } },
    })
  })

  test("parses Responses usage cache details", () => {
    expect(openAIStreamEventToProviderEvents({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    })).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20, totalTokens: 120, reasoningTokens: 5 }])
  })

  test("parses streamed Responses errors as failures", () => {
    expect(openAIStreamEventToProviderEvents({ type: "error", error: { type: "insufficient_quota", code: "insufficient_quota", message: "quota exceeded" } })).toEqual([{ type: "failure", error: { code: "insufficient_quota", message: "quota exceeded", output: "{\"type\":\"insufficient_quota\",\"code\":\"insufficient_quota\",\"message\":\"quota exceeded\"}" } }])
    expect(openAIStreamEventToProviderEvents({ type: "response.failed", response: { error: { code: "insufficient_quota", message: "quota exceeded" } } })).toEqual([{ type: "failure", error: { code: "insufficient_quota", message: "quota exceeded", output: "{\"code\":\"insufficient_quota\",\"message\":\"quota exceeded\"}" } }])
  })

  test("parses DeepSeek tool call deltas and usage chunks", () => {
    const state = createDeepSeekStreamParseState()
    expect(chatCompletionSSEToProviderEvents({ choices: [{ index: 0, delta: { reasoning_content: "Inspect." } }] }, state)).toEqual([{ type: "reasoning_delta", text: "Inspect." }])
    expect(chatCompletionSSEToProviderEvents({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"file" } }] } }] }, state)).toEqual([])
    expect(chatCompletionSSEToProviderEvents({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "Path\":\"README.md\"}" } }] } }] }, state)).toEqual([])
    expect(chatCompletionSSEToProviderEvents({ choices: [{ index: 0, finish_reason: "tool_calls" }] }, state)).toEqual([
      { type: "tool_call", call: { id: "call_1", name: "read", input: { filePath: "README.md" }, rawArguments: "{\"filePath\":\"README.md\"}", reasoningContent: "Inspect." } },
    ])
    expect(chatCompletionSSEToProviderEvents({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } } })).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 4, cacheHitTokens: 7, cacheMissTokens: 3, totalTokens: 14, reasoningTokens: 2 },
    ])
  })

  test("text tool protocol injects tool instructions and strips native tools", () => {
    const readTool = createBuiltinRegistry().get("read")
    if (!readTool) throw new Error("missing read tool")
    const input = textToolProtocolInput({ mode: "build", prompt: "inspect", messages: [], providerMessages: [{ role: "user", content: "inspect" }], tools: [readTool] })
    expect(input.tools).toEqual([])
    expect(input.providerMessages[0]?.role).toBe("system")
    expect(input.providerMessages[0]?.content).toContain("<easycode_tool_call")
    expect(input.providerMessages[0]?.content).toContain("read")
  })

  test("text tool protocol parses tool calls from plain model text", () => {
    expect(textToolProtocolOutputToProviderEvents('Checking.\n<easycode_tool_call name="read" id="call_1">{"filePath":"README.md"}</easycode_tool_call>')).toEqual([
      { type: "text_delta", text: "Checking.\n" },
      { type: "tool_call", call: { id: "call_1", name: "read", input: { filePath: "README.md" }, rawArguments: "{\"filePath\":\"README.md\"}" } },
    ])
    expect(textToolProtocolOutputToProviderEvents('<easycode_tool_call name="list">{"dirPath": .}</easycode_tool_call>')[0]).toMatchObject({
      type: "tool_call",
      call: { name: "list", input: { __easycodeInvalidToolArguments: true, arguments: "{\"dirPath\": .}" } },
    })
  })

  test("text tool protocol provider converts buffered text into provider events", async () => {
    const inner: Provider = {
      name: "plain-text",
      model: "plain-model",
      async *stream(input): AsyncIterable<ProviderEvent> {
        expect(input.tools).toEqual([])
        expect(input.providerMessages[0]?.content).toContain("Text tool protocol")
        yield { type: "text_delta", text: '<easycode_tool_call name="read">' }
        yield { type: "text_delta", text: '{"filePath":"README.md"}</easycode_tool_call>' }
        yield { type: "usage", inputTokens: 5, outputTokens: 2 }
        yield { type: "done" }
      },
    }
    const readTool = createBuiltinRegistry().get("read")
    if (!readTool) throw new Error("missing read tool")
    const events: ProviderEvent[] = []
    for await (const event of new TextToolProtocolProvider(inner).stream({ mode: "build", prompt: "inspect", messages: [], providerMessages: [{ role: "user", content: "inspect" }], tools: [readTool] })) events.push(event)
    expect(events).toContainEqual({ type: "tool_call", call: { id: "call_text_1", name: "read", input: { filePath: "README.md" }, rawArguments: "{\"filePath\":\"README.md\"}" } })
    expect(events).toContainEqual({ type: "usage", inputTokens: 5, outputTokens: 2 })
    expect(events.at(-1)).toEqual({ type: "done" })
  })

  test("text tool protocol parses Anthropic-style wrapped tool_calls XML", () => {
    const input = 'Let me check.\n<tool_calls>\n<invoke name="read_lines">\n<parameter name="filePath">src/cli.ts</parameter>\n<parameter name="startLine">45</parameter>\n<parameter name="endLine">65</parameter>\n</invoke>\n</tool_calls>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      { type: "text_delta", text: "Let me check.\n" },
      { type: "tool_call", call: { id: "call_text_1", name: "read_lines", input: { filePath: "src/cli.ts", startLine: 45, endLine: 65 }, rawArguments: '{"filePath":"src/cli.ts","startLine":45,"endLine":65}' } },
    ])
  })

  test("text tool protocol parses Anthropic-style bare invoke XML", () => {
    const input = '<invoke name="bash">\n<parameter name="command">ls -la</parameter>\n</invoke>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_text_1", name: "bash", input: { command: "ls -la" }, rawArguments: '{"command":"ls -la"}' } },
    ])
  })

  test("text tool protocol parses singular tool_call XML wrappers", () => {
    const input = 'Checking.\n<tool_call>\n<invoke_name>bash</invoke_name>\n<args>\n<invoke>git status --short</invoke>\n</args>\n</tool_call>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      { type: "text_delta", text: "Checking.\n" },
      { type: "tool_call", call: { id: "call_text_1", name: "bash", input: { command: "git status --short" }, rawArguments: '{"command":"git status --short"}' } },
    ])
  })

  test("stream xml filter suppresses singular tool_call wrappers from visible text", () => {
    const filter = new StreamXmlFilter()
    expect(filter.feed("Checking.\n<tool_call>\n<invoke_name>bash</invoke_name>")).toBe("Checking.\n")
    expect(filter.feed("\n<args>\n<invoke>git status --short</invoke>\n</args>\n</tool_call>")).toBe("")
    expect(filter.flush()).toBe("")
  })

  test("text tool protocol parses multiple Anthropic-style invoke blocks", () => {
    const input = '<tool_calls>\n<invoke name="read_lines">\n<parameter name="filePath">a.ts</parameter>\n<parameter name="startLine">1</parameter>\n<parameter name="endLine">10</parameter>\n</invoke>\n<invoke name="read_lines">\n<parameter name="filePath">b.ts</parameter>\n<parameter name="startLine">20</parameter>\n<parameter name="endLine">30</parameter>\n</invoke>\n</tool_calls>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "tool_call", call: { name: "read_lines", input: { filePath: "a.ts", startLine: 1, endLine: 10 } } })
    expect(events[1]).toMatchObject({ type: "tool_call", call: { name: "read_lines", input: { filePath: "b.ts", startLine: 20, endLine: 30 } } })
  })

  test("text tool protocol coerces Anthropic-style parameter types", () => {
    const input = '<invoke name="test_tool">\n<parameter name="flag">true</parameter>\n<parameter name="count">42</parameter>\n<parameter name="ratio">3.14</parameter>\n<parameter name="empty">null</parameter>\n<parameter name="text">hello world</parameter>\n</invoke>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events[0]).toMatchObject({
      type: "tool_call",
      call: { name: "test_tool", input: { flag: true, count: 42, ratio: 3.14, empty: null, text: "hello world" } },
    })
  })

  test("text tool protocol handles Anthropic-style with extra string attribute on parameter", () => {
    const input = '<tool_calls>\n<invoke name="read_lines">\n<parameter name="filePath" string="true">src/tool/code-nav.ts</parameter>\n<parameter name="startLine" string="false">100</parameter>\n<parameter name="endLine" string="false">125</parameter>\n</invoke>\n</tool_calls>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_text_1", name: "read_lines", input: { filePath: "src/tool/code-nav.ts", startLine: 100, endLine: 125 }, rawArguments: '{"filePath":"src/tool/code-nav.ts","startLine":100,"endLine":125}' } },
    ])
  })

  test("text tool protocol prefers easycode format over Anthropic format", () => {
    const input = '<easycode_tool_call name="read" id="call_1">{"filePath":"README.md"}</easycode_tool_call>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_1", name: "read", input: { filePath: "README.md" }, rawArguments: '{"filePath":"README.md"}' } },
    ])
  })

  test("text tool protocol parses DSML-style wrapped XML", () => {
    const input = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="rg_search">\n<｜｜DSML｜｜parameter name="query" string="true">parseArgs\\("</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="dir" string="true">test/unit/cli.test.ts</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="maxResults" string="false">30</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_text_1", name: "rg_search", input: { query: 'parseArgs\\("', dir: "test/unit/cli.test.ts", maxResults: 30 }, rawArguments: '{"query":"parseArgs\\\\(\\"","dir":"test/unit/cli.test.ts","maxResults":30}' } },
    ])
  })

  test("text tool protocol preserves DSML string parameter whitespace for edits", () => {
    const input = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="edit">\n<｜｜DSML｜｜parameter name="filePath" string="true">src/slash.ts</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="oldString" string="true">    "  /skill clear            clear active skills",</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="newString" string="true">    "  /skill remove <name>    remove one active skill",\n    "  /skill clear            clear active skills",</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      {
        type: "tool_call",
        call: {
          id: "call_text_1",
          name: "edit",
          input: {
            filePath: "src/slash.ts",
            oldString: '    "  /skill clear            clear active skills",',
            newString: '    "  /skill remove <name>    remove one active skill",\n    "  /skill clear            clear active skills",',
          },
          rawArguments: '{"filePath":"src/slash.ts","oldString":"    \\"  /skill clear            clear active skills\\",","newString":"    \\"  /skill remove <name>    remove one active skill\\",\\n    \\"  /skill clear            clear active skills\\","}',
        },
      },
    ])
  })

  test("text tool protocol parses DSML-style with half-width pipes", () => {
    const input = '<||DSML||invoke name="read">\n<||DSML||parameter name="filePath">README.md</||DSML||parameter>\n</||DSML||invoke>'
    const events = textToolProtocolOutputToProviderEvents(input)
    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_text_1", name: "read", input: { filePath: "README.md" }, rawArguments: '{"filePath":"README.md"}' } },
    ])
  })

  test("fake provider custom responses register and clear", async () => {
    const provider = new FakeProvider()
    
    // Register by string match
    FakeProvider.registerResponse("custom-prompt", [
      { type: "text_delta", text: "Matched custom string." },
      { type: "done" }
    ])

    const events1 = []
    for await (const event of provider.stream({ mode: "build", prompt: "This is a custom-prompt test", messages: [], providerMessages: [], tools: [] })) {
      events1.push(event)
    }
    expect(events1).toEqual([
      { type: "text_delta", text: "Matched custom string." },
      { type: "done" }
    ])

    // Register by RegExp match
    FakeProvider.registerResponse(/regex-\d+/, [
      { type: "text_delta", text: "Matched custom regex." },
      { type: "done" }
    ])

    const events2 = []
    for await (const event of provider.stream({ mode: "build", prompt: "regex-1234", messages: [], providerMessages: [], tools: [] })) {
      events2.push(event)
    }
    expect(events2).toEqual([
      { type: "text_delta", text: "Matched custom regex." },
      { type: "done" }
    ])

    // Register by custom function matcher
    FakeProvider.registerResponse(
      (input) => input.mode === "plan" && input.prompt.includes("custom-fn"),
      [
        { type: "text_delta", text: "Matched custom function." },
        { type: "done" }
      ]
    )

    const events3 = []
    for await (const event of provider.stream({ mode: "plan", prompt: "custom-fn test", messages: [], providerMessages: [], tools: [] })) {
      events3.push(event)
    }
    expect(events3).toEqual([
      { type: "text_delta", text: "Matched custom function." },
      { type: "done" }
    ])

    // Clear responses
    FakeProvider.clearResponses()
    const events4 = []
    for await (const event of provider.stream({ mode: "build", prompt: "This is a custom-prompt test", messages: [], providerMessages: [], tools: [] })) {
      events4.push(event)
    }
    // Should fallback to default behavior (e.g. read tool call etc.)
    expect(events4.some(e => e.type === "tool_call")).toBe(true)
  })
})

function sseResponse(events: unknown[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}
