import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadEnvFile, parseArgs, parseEnvFile } from "../../src/cli"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-cli-"))
}

describe("cli env loading", () => {
  test("parses dotenv entries", () => {
    const parsed = parseEnvFile(`
      # comment
      OPENAI_API_KEY=from-env
      export EASYCODE_MODEL="codex-mini-latest"
      SINGLE='literal value'
      INVALID-KEY=ignored
    `)
    expect(parsed.get("OPENAI_API_KEY")).toBe("from-env")
    expect(parsed.get("EASYCODE_MODEL")).toBe("codex-mini-latest")
    expect(parsed.get("SINGLE")).toBe("literal value")
    expect(parsed.has("INVALID-KEY")).toBe(false)
  })

  test("loads root .env without overriding existing values", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, ".env"), "OPENAI_API_KEY=from-file\nEXISTING=from-file\n")
    const env: Record<string, string | undefined> = { EXISTING: "from-process" }
    expect(await loadEnvFile(root, env)).toBe(1)
    expect(env.OPENAI_API_KEY).toBe("from-file")
    expect(env.EXISTING).toBe("from-process")
    await rm(root, { recursive: true, force: true })
  })
})

describe("cli args", () => {
  test("session mode is the default and does not accept startup prompts", () => {
    expect(parseArgs(["build", "--provider", "fake"])).toMatchObject({ once: false, session: "default", prompt: "" })
    expect(() => parseArgs(["build", "hello", "--session", "demo"])).toThrow("Session mode is interactive")
  })

  test("session flag selects the interactive session id", () => {
    expect(parseArgs(["build", "--provider", "fake", "--session", "demo"])).toMatchObject({ once: false, session: "demo", prompt: "" })
  })

  test("once mode accepts startup prompts", () => {
    expect(parseArgs(["build", "--once", "hello", "--provider", "fake"])).toMatchObject({ once: true, session: "default", prompt: "hello" })
  })

  test("session startup waits for input before running provider", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "deepseek", "--logger", "--session", "startup", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).not.toContain("provider.request")
    expect(stdout).not.toContain("agent.state")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })
})
