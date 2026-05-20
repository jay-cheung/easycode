import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { CliCodeNavigator } from "../../src/tool/code-navigator"
import { Sandbox } from "../../src/sandbox"

const tempRoots: string[] = []

async function tmpdir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "easycode-nav-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe("code navigator", () => {
  test("readLines reads a bounded 1-based range", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "sample.ts"), "one\ntwo\nthree\n")

    const result = await new CliCodeNavigator(new Sandbox(root)).readLines({ filePath: "src/sample.ts", startLine: 2, endLine: 3 })

    expect(result).toMatchObject({ filePath: "src/sample.ts", startLine: 2, endLine: 3 })
    expect(result.content).toBe("2 | two\n3 | three")
  })

  test("readLines handles empty files", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, "empty.ts"), "")

    const result = await new CliCodeNavigator(new Sandbox(root)).readLines({ filePath: "empty.ts", startLine: 1, endLine: 1 })

    expect(result).toMatchObject({ filePath: "empty.ts", startLine: 1, endLine: 1 })
    expect(result.content).toBe("1 | ")
  })

  test("readLines rejects invalid and overlarge ranges", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, "sample.ts"), Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root))

    await expect(navigator.readLines({ filePath: "sample.ts", startLine: 0, endLine: 1 })).rejects.toThrow("1-based")
    await expect(navigator.readLines({ filePath: "sample.ts", startLine: 1, endLine: 250 })).rejects.toThrow("at most 200 lines")
    await expect(navigator.readLines({ filePath: "sample.ts", startLine: 400, endLine: 401 })).rejects.toThrow("past end of file")
  })

  test("rgSearch parses bounded stable ripgrep results", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const navigator = new CliCodeNavigator(new Sandbox(await tmpdir()), {
      runner: async (command, args) => {
        calls.push({ command, args })
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            JSON.stringify({ type: "match", data: { path: { text: "src/b.ts" }, line_number: 2, lines: { text: "const target = 1\n" } } }),
            JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, line_number: 1, lines: { text: "function target() {}\n" } } }),
          ].join("\n"),
        }
      },
    })

    const results = await navigator.rgSearch({ query: "target", dir: "src", fileType: "ts", maxResults: 1 })

    expect(calls[0]).toMatchObject({ command: "rg" })
    expect(calls[0]?.args).toContain("--glob")
    expect(calls[0]?.args).toContain("*.ts")
    expect(results).toEqual([{ filePath: "src/a.ts", line: 1, preview: "function target() {}" }])
  })

  test("rgSearch treats ripgrep exit code 1 as no results", async () => {
    const navigator = new CliCodeNavigator(new Sandbox(await tmpdir()), {
      runner: async () => ({ exitCode: 1, stderr: "", stdout: "" }),
    })

    await expect(navigator.rgSearch({ query: "missing", dir: "src" })).resolves.toEqual([])
  })

  test("findDefinition fails clearly when ast-grep is missing", async () => {
    const navigator = new CliCodeNavigator(new Sandbox(await tmpdir()), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    await expect(navigator.findDefinition({ symbol: "target" })).rejects.toThrow("ast-grep is required")
  })

  test("repoMap caches generated source skeletons under .easycode/cache", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "auth.ts"), "export class AuthService {\n  login(user: string): string {\n    return user\n  }\n}\n")
    const navigator = new CliCodeNavigator(new Sandbox(root))

    const first = await navigator.repoMap({ dir: "src", language: "typescript" })
    const second = await navigator.repoMap({ dir: "src", language: "typescript" })

    expect(first.cache.hit).toBe(false)
    expect(second.cache.hit).toBe(true)
    expect(second.cache.path).toBe(".easycode/cache/repo-map.json")
    expect(await Bun.file(path.join(root, ".easycode", "cache", "repo-map.json")).exists()).toBe(true)
    expect(second.entries[0]?.symbols).toContainEqual(expect.objectContaining({ name: "AuthService", kind: "class" }))
    expect(second.entries[0]?.symbols).toContainEqual(expect.objectContaining({ name: "login", kind: "method" }))
  })
})
