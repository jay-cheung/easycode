import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { CliCodeNavigator } from "../../src/tool/code-navigator"
import { codeIndexGeneratorVersion } from "../../src/tool/code-navigator/constants"
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

  test("findDefinition uses the code index when ast-grep is missing", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "payment.ts"), "export class PaymentService {\n  pay(amount: number): boolean {\n    return true\n  }\n}\n")
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    const results = await navigator.findDefinition({ symbol: "PaymentService", language: "typescript" })
    expect(results).toEqual([
      { filePath: "src/payment.ts", line: 1, preview: "export class PaymentService" }
    ])
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
    expect(await Bun.file(path.join(root, ".easycode", "cache", "code-index", "index.json")).exists()).toBe(true)
    expect(second.entries[0]?.symbols).toContainEqual(expect.objectContaining({ name: "AuthService", kind: "class" }))
    expect(second.entries[0]?.symbols).toContainEqual(expect.objectContaining({ name: "login", kind: "method" }))
  })

  test("code index records graph edges and powers definition/reference lookup", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "auth.ts"), [
      "import { tokenStore } from './store'",
      "export class AuthService extends BaseService implements LoginProvider {",
      "  login(user: string): string {",
      "    return verifyToken(user)",
      "  }",
      "}",
      "export function verifyToken(user: string): string {",
      "  return tokenStore.get(user)",
      "}",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    await navigator.repoMap({ dir: "src", language: "typescript" })
    const index = await Bun.file(path.join(root, ".easycode", "cache", "code-index", "index.json")).json()
    const definitions = await navigator.findDefinition({ symbol: "verifyToken", language: "typescript" })
    const references = await navigator.findReferences({ symbol: "verifyToken", language: "typescript" })

    expect(index.files[0]?.imports).toEqual(["./store"])
    expect(index.files[0]?.exports).toContain("AuthService")
    expect(index.edges).toContainEqual(expect.objectContaining({ kind: "inherits", to: "BaseService" }))
    expect(index.edges).toContainEqual(expect.objectContaining({ kind: "implements", to: "LoginProvider" }))
    expect(index.edges).toContainEqual(expect.objectContaining({ kind: "calls", to: "verifyToken", line: 4 }))
    expect(definitions).toEqual([{ filePath: "src/auth.ts", line: 7, preview: "export function verifyToken(user: string): string" }])
    expect(references).toEqual([{ filePath: "src/auth.ts", line: 4, preview: "    return verifyToken(user)" }])
  })

  test("code index reference lookup covers constructors types and property receivers", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "auth.ts"), [
      "export class AuthService {",
      "  login(user: string): string {",
      "    return user",
      "  }",
      "}",
      "export const tokenStore = {",
      "  get(user: string) {",
      "    return user",
      "  }",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "use-auth.ts"), [
      "import { AuthService, tokenStore } from './auth'",
      "export function run(user: string): string {",
      "  const service: AuthService = new AuthService()",
      "  return tokenStore.get(service.login(user))",
      "  // tokenStore.get(user) is only documentation",
      "  const note = 'AuthService tokenStore.get(user)'",
      "}",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    await navigator.repoMap({ dir: "src", language: "typescript" })
    const index = await Bun.file(path.join(root, ".easycode", "cache", "code-index", "index.json")).json()
    const authReferences = await navigator.findReferences({ symbol: "AuthService", language: "typescript" })
    const storeReferences = await navigator.findReferences({ symbol: "tokenStore", language: "typescript" })

    expect(index.generatorVersion).toBe(codeIndexGeneratorVersion)
    expect(index.edges).toContainEqual(expect.objectContaining({ kind: "references", to: "AuthService", line: 3 }))
    expect(index.edges).toContainEqual(expect.objectContaining({ kind: "references", to: "tokenStore", line: 4 }))
    expect(authReferences).toEqual([
      { filePath: "src/use-auth.ts", line: 3, preview: "  const service: AuthService = new AuthService()" },
    ])
    expect(storeReferences).toEqual([
      { filePath: "src/use-auth.ts", line: 4, preview: "  return tokenStore.get(service.login(user))" },
    ])
  })

  test("repoMap filters symbols and files based on semantic query", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "auth.ts"), "export class AuthService {\n  login(user: string): string {\n    return user\n  }\n}\n")
    await Bun.write(path.join(root, "src", "payment.ts"), "export class PaymentService {\n  pay(amount: number): boolean {\n    return true\n  }\n}\n")
    const navigator = new CliCodeNavigator(new Sandbox(root))

    const map = await navigator.repoMap({ dir: "src", language: "typescript", query: "payment pay" })

    expect(map.entries.length).toBe(1)
    expect(map.entries[0]?.filePath).toBe("src/payment.ts")
    expect(map.entries[0]?.symbols).toContainEqual(expect.objectContaining({ name: "PaymentService" }))
    expect(map.entries[0]?.symbols).toContainEqual(expect.objectContaining({ name: "pay" }))
    expect(map.entries[0]?.symbols.some(s => s.name === "AuthService")).toBe(false)
  })

  test("repoMap query matches symbol signatures and file imports", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "handlers.ts"), [
      "import { createAuditSink } from '@internal/audit-sdk'",
      "export function buildSink(event: AuditEvent): AuditSink {",
      "  return createAuditSink(event)",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b\n}\n")
    const navigator = new CliCodeNavigator(new Sandbox(root))

    const signatureMatch = await navigator.repoMap({ dir: "src", language: "typescript", query: "AuditEvent" })
    const importMatch = await navigator.repoMap({ dir: "src", language: "typescript", query: "audit-sdk" })

    expect(signatureMatch.entries.map((entry) => entry.filePath)).toEqual(["src/handlers.ts"])
    expect(signatureMatch.entries[0]?.symbols).toContainEqual(expect.objectContaining({ name: "buildSink" }))
    expect(importMatch.entries.map((entry) => entry.filePath)).toEqual(["src/handlers.ts"])
  })

  test("code index incrementally rebuilds changed files only", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "a.ts"), "export function alpha() {\n  return 1\n}\n")
    await Bun.write(path.join(root, "src", "b.ts"), "export function beta() {\n  return 2\n}\n")
    const navigator = new CliCodeNavigator(new Sandbox(root))

    await navigator.repoMap({ dir: "src", language: "typescript" })
    await Bun.sleep(5)
    await Bun.write(path.join(root, "src", "b.ts"), "export function beta() {\n  return 3\n}\n")
    await navigator.repoMap({ dir: "src", language: "typescript" })
    const index = await Bun.file(path.join(root, ".easycode", "cache", "code-index", "index.json")).json()

    expect(index.cache.rebuiltFiles).toBe(1)
    expect(index.symbols.map((symbol: { name: string }) => symbol.name).sort()).toEqual(["alpha", "beta"])
  })

  test("callGraph follows resolved cross-file import aliases", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "leaf.ts"), "export function leaf() {\n  return 1\n}\n")
    await Bun.write(path.join(root, "src", "parent.ts"), [
      "import { leaf as makeLeaf } from './leaf'",
      "export function parent() {",
      "  return makeLeaf()",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "main.ts"), [
      "import { parent } from './parent'",
      "export function main() {",
      "  return parent()",
      "}",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root))

    const graph = await navigator.callGraph({ symbol: "leaf", direction: "callers", depth: 2, language: "typescript" })

    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["leaf", "main", "parent"])
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "src/parent.ts#parent", to: "src/leaf.ts#leaf", line: 3 }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "src/main.ts#main", to: "src/parent.ts#parent", line: 3 }))
  })

  test("callGraph resolves default import aliases to default exports instead of unrelated named exports", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "leaf.ts"), [
      "export function helper() {",
      "  return 0",
      "}",
      "export default function leaf() {",
      "  return helper() + 1",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "parent.ts"), [
      "import makeLeaf from './leaf'",
      "export function parent() {",
      "  return makeLeaf()",
      "}",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root))

    const graph = await navigator.callGraph({ symbol: "leaf", direction: "callers", depth: 1, language: "typescript" })

    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["leaf", "parent"])
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "src/parent.ts#parent", to: "src/leaf.ts#leaf", line: 3 }))
    expect(graph.edges.some((edge) => edge.to === "src/leaf.ts#helper")).toBe(false)
  })

  test("callGraph resolves namespace import member calls to the imported file even with same-name collisions", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "leaf.ts"), [
      "export function leaf() {",
      "  return 1",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "other.ts"), [
      "export function leaf() {",
      "  return 2",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "parent.ts"), [
      "import * as leafApi from './leaf'",
      "export function parent() {",
      "  return leafApi.leaf()",
      "}",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root))

    const graph = await navigator.callGraph({ symbol: "leaf", direction: "callers", depth: 1, language: "typescript" })

    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: "src/leaf.ts#leaf", name: "leaf" }))
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: "src/parent.ts#parent", name: "parent" }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "src/parent.ts#parent", to: "src/leaf.ts#leaf", line: 3 }))
    expect(graph.edges.some((edge) => edge.to === "src/other.ts#leaf")).toBe(false)
  })

  test("AST local binding scope prevents same-name false references", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "store.ts"), [
      "export const tokenStore = {",
      "  get(user: string) {",
      "    return user",
      "  }",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "use-store.ts"), [
      "import { tokenStore } from './store'",
      "export function useLocal(tokenStore: string): string {",
      "  const local = tokenStore",
      "  return local",
      "}",
      "export function useImported(user: string): string {",
      "  return tokenStore.get(user)",
      "}",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    await navigator.repoMap({ dir: "src", language: "typescript" })
    const index = await Bun.file(path.join(root, ".easycode", "cache", "code-index", "index.json")).json()
    const references = await navigator.findReferences({ symbol: "tokenStore", language: "typescript" })

    expect(index.symbols.map((symbol: { filePath: string; name: string }) => `${symbol.filePath}#${symbol.name}`)).not.toContain("src/use-store.ts#local")
    expect(references).toEqual([
      { filePath: "src/use-store.ts", line: 7, preview: "  return tokenStore.get(user)" },
    ])
  })

  test("code index ignores block comments and multiline template literals for reference lookup", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "store.ts"), [
      "export const tokenStore = {",
      "  get(user: string) {",
      "    return user",
      "  }",
      "}",
    ].join("\n"))
    await Bun.write(path.join(root, "src", "use-store.ts"), [
      "import { tokenStore } from './store'",
      "export function useGlobal(user: string): string {",
      "  /*",
      "    tokenStore.get(user)",
      "  */",
      "  const note = `tokenStore",
      "  tokenStore.get(user)`",
      "  return tokenStore.get(user)",
      "}",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    await navigator.repoMap({ dir: "src", language: "typescript" })
    const references = await navigator.findReferences({ symbol: "tokenStore", language: "typescript" })

    expect(references).toEqual([
      { filePath: "src/use-store.ts", line: 8, preview: "  return tokenStore.get(user)" },
    ])
  })

  test("code index extracts symbols and call graph for non-TypeScript files", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await Bun.write(path.join(root, "pkg", "service.py"), [
      "def leaf():",
      "    return 1",
      "",
      "def parent():",
      "    return leaf()",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root))

    const definitions = await navigator.findDefinition({ symbol: "parent", language: "python" })
    const graph = await navigator.callGraph({ symbol: "leaf", direction: "callers", depth: 1, language: "python" })

    expect(definitions).toEqual([{ filePath: "pkg/service.py", line: 4, preview: "def parent():" }])
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "pkg/service.py#parent", to: "pkg/service.py#leaf", line: 5 }))
  })

  test("generic AST local binding scope prevents non-TypeScript false references", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await Bun.write(path.join(root, "pkg", "service.py"), [
      "def token_store():",
      "    return 1",
      "",
      "def use_local(token_store):",
      "    local = token_store",
      "    return local",
      "",
      "def use_global():",
      "    return token_store()",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    await navigator.repoMap({ dir: "pkg", language: "python" })
    const references = await navigator.findReferences({ symbol: "token_store", language: "python" })

    expect(references).toEqual([
      { filePath: "pkg/service.py", line: 9, preview: "    return token_store()" },
    ])
  })

  test("code index ignores Python triple-quoted strings for reference lookup", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await Bun.write(path.join(root, "pkg", "service.py"), [
      "def token_store():",
      "    return 1",
      "",
      "def use_global():",
      "    \"\"\"",
      "    token_store()",
      "    \"\"\"",
      "    note = '''token_store()'''",
      "    return token_store()",
    ].join("\n"))
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      },
    })

    await navigator.repoMap({ dir: "pkg", language: "python" })
    const references = await navigator.findReferences({ symbol: "token_store", language: "python" })

    expect(references).toEqual([
      { filePath: "pkg/service.py", line: 9, preview: "    return token_store()" },
    ])
  })

  test("generic AST local binding scope covers Java-like, Rust, Go, and C++ files", async () => {
    const cases = [
      {
        language: "java",
        filePath: "src/Service.java",
        symbol: "tokenStore",
        expectedLine: 10,
        expectedPreview: "    return tokenStore();",
        source: [
          "public class Service {",
          "  public static int tokenStore() {",
          "    return 1;",
          "  }",
          "  public int useLocal(int tokenStore) {",
          "    int local = tokenStore;",
          "    return local;",
          "  }",
          "  public int useGlobal() {",
          "    return tokenStore();",
          "  }",
          "}",
        ],
      },
      {
        language: "kotlin",
        filePath: "src/service.kt",
        symbol: "tokenStore",
        expectedLine: 11,
        expectedPreview: "    return tokenStore()",
        source: [
          "fun tokenStore(): Int {",
          "    return 1",
          "}",
          "",
          "fun useLocal(tokenStore: Int): Int {",
          "    val local = tokenStore",
          "    return local",
          "}",
          "",
          "fun useGlobal(): Int {",
          "    return tokenStore()",
          "}",
        ],
      },
      {
        language: "rust",
        filePath: "src/service.rs",
        symbol: "token_store",
        expectedLine: 11,
        expectedPreview: "    token_store()",
        source: [
          "fn token_store() -> i32 {",
          "    1",
          "}",
          "",
          "fn use_local(token_store: i32) -> i32 {",
          "    let local = token_store;",
          "    local",
          "}",
          "",
          "fn use_global() -> i32 {",
          "    token_store()",
          "}",
        ],
      },
      {
        language: "go",
        filePath: "src/service.go",
        symbol: "tokenStore",
        expectedLine: 11,
        expectedPreview: "    return tokenStore()",
        source: [
          "func tokenStore() int {",
          "    return 1",
          "}",
          "",
          "func useLocal(tokenStore int) int {",
          "    local := tokenStore",
          "    return local",
          "}",
          "",
          "func useGlobal() int {",
          "    return tokenStore()",
          "}",
        ],
      },
      {
        language: "cpp",
        filePath: "src/service.cpp",
        symbol: "token_store",
        expectedLine: 11,
        expectedPreview: "    return token_store();",
        source: [
          "int token_store() {",
          "    return 1;",
          "}",
          "",
          "int use_local(int token_store) {",
          "    int local = token_store;",
          "    return local;",
          "}",
          "",
          "int use_global() {",
          "    return token_store();",
          "}",
        ],
      },
    ]

    for (const item of cases) {
      const root = await tmpdir()
      await mkdir(path.join(root, "src"), { recursive: true })
      await Bun.write(path.join(root, item.filePath), item.source.join("\n"))
      const navigator = new CliCodeNavigator(new Sandbox(root), {
        runner: async () => {
          throw new Error("ENOENT")
        },
      })

      await navigator.repoMap({ dir: "src", language: item.language })
      const references = await navigator.findReferences({ symbol: item.symbol, language: item.language })

      expect(references).toEqual([
        { filePath: item.filePath, line: item.expectedLine, preview: item.expectedPreview },
      ])
    }
  })

  test("pure JS rgSearch fallback scans files and matches query regex", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "payment.ts"), "export class PaymentService {\n  pay(amount: number): boolean {\n    return true\n  }\n}\n")
    // Force ripgrep runner to throw ENOENT to trigger the pure JS fallback
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      }
    })

    const results = await navigator.rgSearch({ query: "pay\\(", dir: "src" })
    expect(results).toEqual([
      { filePath: "src/payment.ts", line: 2, preview: "  pay(amount: number): boolean {" }
    ])
  })

  test("indexed findDefinition matches symbol declarations without external tools", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "payment.ts"), "export class PaymentService {\n  pay(amount: number): boolean {\n    return true\n  }\n}\n")
    // Force ast-grep runner to throw ENOENT to trigger the pure JS fallback
    const navigator = new CliCodeNavigator(new Sandbox(root), {
      runner: async () => {
        throw new Error("ENOENT")
      }
    })

    const results = await navigator.findDefinition({ symbol: "PaymentService", language: "typescript" })
    expect(results).toEqual([
      { filePath: "src/payment.ts", line: 1, preview: "export class PaymentService" }
    ])
  })
})
