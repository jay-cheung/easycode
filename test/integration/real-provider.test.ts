import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AgentRunner } from "../../src/agent"
import { createProvider, hasProvider, type ProviderName } from "../../src/provider"
import type { ToolContext, ToolRegistryLike, ToolResult } from "../../src/tool"

const realProviderName = process.env.EASYCODE_TEST_PROVIDER as ProviderName | undefined
const realProviderTest = realProviderName ? test : test.skip

const emptyRegistry: ToolRegistryLike = {
  get: () => undefined,
  list: () => [],
  run: async (name: string, _input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({
    title: "Unexpected tool",
    output: `Unexpected tool call: ${name}`,
    metadata: { status: "failed" },
  }),
}

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-real-provider-"))
}

function configuredProvider() {
  if (!realProviderName || !hasProvider(realProviderName)) throw new Error(`Set EASYCODE_TEST_PROVIDER to one of: openai, deepseek, openai-compatible`)
  return createProvider(realProviderName)
}

describe("real provider", () => {
  realProviderTest("streams text from configured provider", async () => {
    const provider = configuredProvider()
    let text = ""
    for await (const event of provider.stream({ mode: "build", prompt: "Reply with exactly: easycode real provider ok", messages: [], providerMessages: [{ role: "user", content: "Reply with exactly: easycode real provider ok" }], tools: [] })) {
      if (event.type === "text_delta") text += event.text
      if (event.type === "failure") throw new Error(event.error.output || event.error.message)
    }
    expect(text.toLowerCase()).toContain("easycode real provider ok")
  })

  realProviderTest("agent runner completes with configured provider", async () => {
    const root = await tmpdir()
    try {
      const result = await new AgentRunner({ root, provider: configuredProvider(), registry: emptyRegistry, maxSteps: 2 }).run("Reply with exactly: easycode agent ok", "build")
      expect(result.status).toBe("completed")
      expect(result.text.toLowerCase()).toContain("easycode agent ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
