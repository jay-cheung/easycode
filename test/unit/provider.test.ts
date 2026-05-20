import { describe, expect, test } from "bun:test"
import { chatCompletionSSEToProviderEvents, createDeepSeekStreamParseState, createOpenAIStreamParseState, createProvider, DeepSeekProvider, FakeProvider, hasProvider, listProviders, OpenAILikeProvider, OpenAIProvider, normalizeModelName, openAIStreamEventToProviderEvents, providerMessageToResponseInput, registerProvider, toolToResponseTool } from "../../src/provider"
import { imagePart, messagesToProviderInput, textMessage, toolCallMessage, toolResultMessage, userMessage } from "../../src/message"
import { createBuiltinRegistry } from "../../src/tool"

describe("provider", () => {
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

  test("normalizes common OpenAI model display casing", () => {
    expect(normalizeModelName("GPT-5.4-mini")).toBe("gpt-5.4-mini")
    expect(normalizeModelName("O3")).toBe("o3")
    expect(new OpenAIProvider("GPT-5-mini").model).toBe("gpt-5-mini")
  })

  test("OpenAI and DeepSeek providers share OpenAI-like base", () => {
    expect(new OpenAIProvider("gpt-5-mini")).toBeInstanceOf(OpenAILikeProvider)
    expect(new DeepSeekProvider("deepseek-chat")).toBeInstanceOf(OpenAILikeProvider)
    expect(new DeepSeekProvider("deepseek-chat").name).toBe("deepseek")
  })

  test("provider registry creates registered providers", () => {
    expect(listProviders()).toContain("fake")
    expect(listProviders()).toContain("openai")
    expect(listProviders()).toContain("deepseek")
    expect(hasProvider("fake")).toBe(true)
    expect(createProvider("fake")).toBeInstanceOf(FakeProvider)
    expect(() => registerProvider("fake", () => new FakeProvider())).toThrow("Provider already registered")
    expect(() => createProvider("missing")).toThrow("Unknown provider")
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
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ])
  })

  test("emits raw OpenAI request before fetch", async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const provider = new OpenAIProvider("gpt-5-mini")
      const stream = provider.stream({ mode: "build", prompt: "hi", messages: [], providerMessages: [{ role: "user", content: "hi" }], tools: [] })[Symbol.asyncIterator]()
      const first = await stream.next()
      await stream.return?.()
      expect(first.value).toMatchObject({
        type: "request",
        request: {
          url: "https://api.openai.com/v1/responses",
          method: "POST",
          body: {
            model: "gpt-5-mini",
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
            reasoning: { effort: "high" },
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

  test("rejects image input for DeepSeek before fetch", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-chat")
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
      const provider = new DeepSeekProvider("deepseek-chat")
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
            model: "deepseek-chat",
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

  test("adds DeepSeek JSON response format when requested", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-chat", { responseFormat: "json_object" })
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
      const provider = new DeepSeekProvider("deepseek-chat", { maxOutputTokens: 123 })
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

  test("maps structured tool history to DeepSeek chat messages", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "test-key"
    try {
      const provider = new DeepSeekProvider("deepseek-chat")
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
              { role: "tool", tool_call_id: "call_1", content: "README.md" },
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
      const provider = new DeepSeekProvider("deepseek-chat")
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
      const provider = new DeepSeekProvider("deepseek-chat")
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
