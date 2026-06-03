import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { WebSearchService } from "../../src/retrieval"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-retrieval-"))
}

describe("web retrieval", () => {
  test("uses implicit Tavily default engine from environment without config file", async () => {
    const root = await tmpdir()
    try {
      const requests: Array<{ body: string; headers: Headers }> = []
      const service = new WebSearchService(root, {
        env: {
          TAVILY_API_KEY: "tavily-token",
        },
        fetch: async (_input, init) => {
          requests.push({ body: String(init?.body), headers: new Headers(init?.headers) })
          return Response.json({
            results: [
              { title: "Implicit Tavily", url: "https://example.com/tavily", content: "Implicit Tavily default result." },
            ],
          })
        },
      })

      const response = await service.search("easycode", 3)

      expect(response).toMatchObject({ live: true, engine: "tavily" })
      expect(response.results).toEqual([
        expect.objectContaining({ title: "Implicit Tavily", url: "https://example.com/tavily", snippet: "Implicit Tavily default result." }),
      ])
      expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ query: "easycode", max_results: 3 })
      expect(requests[0]?.headers.get("Authorization")).toBe("Bearer tavily-token")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("can explicitly use fixtures even when a live engine is configured", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "tavily",
        engines: [{ name: "tavily", type: "tavily", apiKeyEnv: "TAVILY_API_KEY" }],
        results: [{ title: "Fixture result", url: "https://fixture.test", snippet: "fixture snippet" }],
      }))
      const service = new WebSearchService(root, {
        env: { TAVILY_API_KEY: "tavily-token" },
        fetch: async () => {
          throw new Error("live fetch should not be called")
        },
      })

      const response = await service.search("fixture", 5, { live: false })

      expect(response.live).toBe(false)
      expect(response.warning).toBe("live search disabled by request")
      expect(response.results).toEqual([expect.objectContaining({ title: "Fixture result" })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails when a requested live engine is not configured", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        engines: [{ name: "tavily", type: "tavily", apiKeyEnv: "TAVILY_API_KEY" }],
      }))
      const service = new WebSearchService(root, { env: { TAVILY_API_KEY: "tavily-token" } })

      await expect(service.search("codex", 5, { engine: "missing" })).rejects.toThrow("web search engine not found: missing")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("requires a configured engine when live search is explicitly requested", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        results: [{ title: "Fixture result", url: "https://fixture.test", snippet: "fixture snippet" }],
      }))
      const service = new WebSearchService(root, { env: {} })

      await expect(service.search("codex", 5, { live: true })).rejects.toThrow("live web search requires a configured engine. Configure Tavily with TAVILY_API_KEY. Set it in ~/.easycode/.env or your shell environment.")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unsupported engine types fail with a tavily-only message", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "google",
        engines: [{ name: "google", type: "google", apiKeyEnv: "GOOGLE_SEARCH_API_KEY" }],
      }))
      const service = new WebSearchService(root, { env: { GOOGLE_SEARCH_API_KEY: "google-token" } })

      await expect(service.search("easycode", 5)).rejects.toThrow("web search engine google type google is not supported; only tavily is available. Configure Tavily with TAVILY_API_KEY. Set it in ~/.easycode/.env or your shell environment.")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing api key error points to .env or shell configuration", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "tavily",
        engines: [{
          name: "tavily",
          type: "tavily",
          apiKeyEnv: "TAVILY_API_KEY",
        }],
      }))
      const service = new WebSearchService(root, {
        env: {},
        fetch: async () => {
          throw new Error("live fetch should not be called")
        },
      })

      await expect(service.search("easycode", 3)).rejects.toThrow("web search engine tavily requires TAVILY_API_KEY. Set it in ~/.easycode/.env or your shell environment.")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
