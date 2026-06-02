import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { WebSearchService } from "../../src/retrieval"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-retrieval-"))
}

describe("web retrieval", () => {
  test("uses implicit Google default engine from environment without config file", async () => {
    const root = await tmpdir()
    try {
      const requests: Array<{ url: string; headers: Headers }> = []
      const service = new WebSearchService(root, {
        env: {
          GOOGLE_SEARCH_API_KEY: "google-token",
          GOOGLE_SEARCH_CX: "programmable-engine-id",
        },
        fetch: async (input, init) => {
          requests.push({ url: String(input), headers: new Headers(init?.headers) })
          return Response.json({
            items: [
              { title: "Implicit EasyCode", link: "https://example.com/implicit", snippet: "Implicit Google default result." },
            ],
          })
        },
      })

      const response = await service.search("easycode", 3)

      expect(response).toMatchObject({ live: true, engine: "google" })
      expect(response.results).toEqual([
        expect.objectContaining({ title: "Implicit EasyCode", url: "https://example.com/implicit", snippet: "Implicit Google default result." }),
      ])
      expect(requests[0]?.url).toContain("https://customsearch.googleapis.com/customsearch/v1")
      expect(requests[0]?.url).toContain("num=3")
      expect(requests[0]?.url).toContain("cx=programmable-engine-id")
      expect(requests[0]?.url).toContain("key=google-token")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("uses configured Google Programmable Search engine for live web search", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "google",
        engines: [{
          name: "google",
          type: "google",
          apiKeyEnv: "GOOGLE_SEARCH_API_KEY",
          extraParams: { cx: "programmable-engine-id", hl: "en" },
        }],
      }))
      const requests: Array<{ url: string; headers: Headers }> = []
      const service = new WebSearchService(root, {
        env: { GOOGLE_SEARCH_API_KEY: "google-token" },
        fetch: async (input, init) => {
          requests.push({ url: String(input), headers: new Headers(init?.headers) })
          return Response.json({
            items: [
              { title: "EasyCode", link: "https://example.com/easycode", snippet: "Programmable search result." },
            ],
          })
        },
      })

      const response = await service.search("easycode", 4)

      expect(response).toMatchObject({ live: true, engine: "google" })
      expect(response.results).toEqual([
        expect.objectContaining({ title: "EasyCode", url: "https://example.com/easycode", snippet: "Programmable search result.", source: "example.com" }),
      ])
      expect(requests[0]?.url).toContain("https://customsearch.googleapis.com/customsearch/v1")
      expect(requests[0]?.url).toContain("q=easycode")
      expect(requests[0]?.url).toContain("num=4")
      expect(requests[0]?.url).toContain("cx=programmable-engine-id")
      expect(requests[0]?.url).toContain("key=google-token")
      expect(requests[0]?.url).toContain("hl=en")
      expect(requests[0]?.headers.get("Authorization")).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("uses configured Brave Search engine for live web search", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "brave",
        engines: [{ name: "brave", type: "brave", apiKeyEnv: "BRAVE_SEARCH_API_KEY", extraParams: { country: "US" } }],
      }))
      const requests: Array<{ url: string; headers: Headers }> = []
      const service = new WebSearchService(root, {
        env: { BRAVE_SEARCH_API_KEY: "brave-token" },
        fetch: async (input, init) => {
          requests.push({ url: String(input), headers: new Headers(init?.headers) })
          return Response.json({
            web: {
              results: [
                { title: "OpenAI Codex CLI", url: "https://developers.openai.com/codex/cli", description: "Local coding agent docs." },
              ],
            },
          })
        },
      })

      const response = await service.search("codex cli", 3)

      expect(response).toMatchObject({ live: true, engine: "brave" })
      expect(response.results).toEqual([
        expect.objectContaining({ title: "OpenAI Codex CLI", url: "https://developers.openai.com/codex/cli", snippet: "Local coding agent docs.", source: "developers.openai.com" }),
      ])
      expect(requests[0]?.url).toContain("https://api.search.brave.com/res/v1/web/search")
      expect(requests[0]?.url).toContain("q=codex+cli")
      expect(requests[0]?.url).toContain("count=3")
      expect(requests[0]?.url).toContain("country=US")
      expect(requests[0]?.headers.get("X-Subscription-Token")).toBe("brave-token")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("supports custom configured search engines", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        engines: [
          {
            name: "internal-search",
            type: "custom",
            endpoint: "https://search.example.test/query",
            method: "POST",
            apiKeyEnv: "INTERNAL_SEARCH_TOKEN",
            apiKeyHeader: "X-API-Key",
            queryParam: "text",
            limitParam: "size",
            resultsPath: "data.items",
            titlePath: "headline",
            urlPath: "link",
            snippetPath: "summary",
            sourcePath: "publisher",
            extraParams: { freshness: "week" },
          },
        ],
      }))
      const bodies: string[] = []
      const service = new WebSearchService(root, {
        env: { INTERNAL_SEARCH_TOKEN: "internal-token" },
        fetch: async (_input, init) => {
          bodies.push(String(init?.body))
          expect(new Headers(init?.headers).get("X-API-Key")).toBe("internal-token")
          return Response.json({
            data: {
              items: [
                { headline: "Custom result", link: "https://example.test/a", summary: "Custom snippet", publisher: "Example Search" },
              ],
            },
          })
        },
      })

      const response = await service.search("custom query", 2, { engine: "internal-search" })

      expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ freshness: "week", text: "custom query", size: 2 })
      expect(response).toMatchObject({ live: true, engine: "internal-search" })
      expect(response.results).toEqual([
        expect.objectContaining({ title: "Custom result", url: "https://example.test/a", snippet: "Custom snippet", source: "Example Search" }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("can explicitly use fixtures even when a live engine is configured", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "brave",
        engines: [{ name: "brave", type: "brave", apiKeyEnv: "BRAVE_SEARCH_API_KEY" }],
        results: [{ title: "Fixture result", url: "https://fixture.test", snippet: "fixture snippet" }],
      }))
      const service = new WebSearchService(root, {
        env: { BRAVE_SEARCH_API_KEY: "brave-token" },
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
        engines: [{ name: "brave", type: "brave", apiKeyEnv: "BRAVE_SEARCH_API_KEY" }],
      }))
      const service = new WebSearchService(root, { env: { BRAVE_SEARCH_API_KEY: "brave-token" } })

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
      const service = new WebSearchService(root)

      await expect(service.search("codex", 5, { live: true })).rejects.toThrow("live web search requires a configured engine; configure Google with GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("google engine requires configurable cx", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "google",
        engines: [{ name: "google", type: "google", apiKeyEnv: "GOOGLE_SEARCH_API_KEY" }],
      }))
      const service = new WebSearchService(root, { env: { GOOGLE_SEARCH_API_KEY: "google-token" } })

      await expect(service.search("easycode", 5)).rejects.toThrow("google web search engine google requires extraParams.cx or GOOGLE_SEARCH_CX")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fills configured google engine cx from environment", async () => {
    const root = await tmpdir()
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true })
      await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
        defaultEngine: "google",
        engines: [{ name: "google", type: "google", apiKeyEnv: "GOOGLE_SEARCH_API_KEY" }],
      }))
      const requests: string[] = []
      const service = new WebSearchService(root, {
        env: {
          GOOGLE_SEARCH_API_KEY: "google-token",
          GOOGLE_SEARCH_ENGINE_ID: "programmable-engine-id",
        },
        fetch: async (input) => {
          requests.push(String(input))
          return Response.json({ items: [] })
        },
      })

      const response = await service.search("easycode", 2)

      expect(response).toMatchObject({ live: true, engine: "google" })
      expect(requests[0]).toContain("cx=programmable-engine-id")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
