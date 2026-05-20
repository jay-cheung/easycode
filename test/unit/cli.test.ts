import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
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
    expect(parseArgs(["build", "--provider", "fake"])).toMatchObject({ once: false, session: undefined, prompt: "" })
    expect(() => parseArgs(["build", "hello", "--session", "demo"])).toThrow("Session mode is interactive")
  })

  test("session flag selects the interactive session id", () => {
    expect(parseArgs(["build", "--provider", "fake", "--session", "demo"])).toMatchObject({ once: false, session: "demo", prompt: "" })
  })

  test("once mode accepts startup prompts", () => {
    expect(parseArgs(["build", "--once", "hello", "--provider", "fake"])).toMatchObject({ once: true, session: undefined, prompt: "hello" })
  })

  test("context and step budgets can be set at startup", () => {
    expect(parseArgs(["build", "--once", "hello", "--provider", "fake", "--max-tokens", "64000", "--max-steps", "24"])).toMatchObject({ maxTokens: 64_000, maxSteps: 24, prompt: "hello" })
    expect(() => parseArgs(["build", "--max-steps", "nope"])).toThrow("--max-steps requires a positive number")
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

  test("session startup creates default when no project sessions exist", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Starting new session: default")
    expect(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).exists()).toBe(true)
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session startup lets users choose or create when sessions exist", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "sessions"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "sessions", "alpha.json"), JSON.stringify({ id: "alpha", messages: [], updatedAt: 100 }, null, 2))
    await Bun.write(path.join(root, ".easycode", "sessions", "beta.json"), JSON.stringify({ id: "beta", messages: [], updatedAt: 200 }, null, 2))

    const chooseExisting = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    chooseExisting.stdin.write("2\n:exit\n")
    chooseExisting.stdin.end()
    const [chooseStdout, chooseStderr, chooseStatus] = await Promise.all([new Response(chooseExisting.stdout).text(), new Response(chooseExisting.stderr).text(), chooseExisting.exited])
    expect(chooseStatus).toBe(0)
    expect(chooseStdout).toContain("Select a session:")
    expect(chooseStdout).toContain("1. beta")
    expect(chooseStdout).toContain("2. alpha")
    expect(JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "alpha.json")).text()).updatedAt).toBeGreaterThan(200)
    expect(chooseStderr).toBe("")

    const createNew = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    createNew.stdin.write("fresh\n:exit\n")
    createNew.stdin.end()
    const [_createStdout, createStderr, createStatus] = await Promise.all([new Response(createNew.stdout).text(), new Response(createNew.stderr).text(), createNew.exited])
    expect(createStatus).toBe(0)
    expect(await Bun.file(path.join(root, ".easycode", "sessions", "fresh.json")).exists()).toBe(true)
    expect(createStderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session continues after max steps", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "add.ts"), "export const value = 1\n")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("loop forever\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Still working.")
    expect(stdout).toContain("Continue with another message to keep going.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session queues input typed during an active run", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("delayed answer\n")
    await new Promise((resolve) => setTimeout(resolve, 150))
    child.stdin.write("queued-ok\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Queued next input: queued-ok")
    expect(stdout).toContain("Delayed done.")
    expect(stdout).toContain("Queued done.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session cancels the active run from typed input", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("slow command\n")
    await new Promise((resolve) => setTimeout(resolve, 120))
    child.stdin.write("y\n")
    await new Promise((resolve) => setTimeout(resolve, 120))
    child.stdin.write("/cancel\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Type /cancel to stop this run")
    expect(stdout).toContain("Cancelling current run...")
    expect(stdout).toContain("Run cancelled by user.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session asks before reading env files", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, ".env"), "SECRET=hidden\n")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("Read env configuration\nn\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Allow read for .env?")
    expect(stdout).not.toContain("SECRET=hidden")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("non-logger session renders image reasoning as a timeline", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, "pic.png"), "image-bytes")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("/image pic.png\n")
    await new Promise((resolve) => setTimeout(resolve, 120))
    child.stdin.write("Describe it\n")
    await new Promise((resolve) => setTimeout(resolve, 120))
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Attached image:")
    expect(stdout).toContain("● Thought")
    expect(stdout).toContain("I should inspect the attached image.")
    expect(stdout).toContain("● Answer")
    expect(stdout).toContain("Image received.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("logger session does not enable timeline rendering", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, "pic.png"), "image-bytes")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--logger", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("/image pic.png\n")
    await new Promise((resolve) => setTimeout(resolve, 120))
    child.stdin.write("Describe it\n")
    await new Promise((resolve) => setTimeout(resolve, 120))
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).not.toContain("● Thought")
    expect(stdout).toContain("I should inspect the attached image.")
    expect(stdout).toContain("[easycode]")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })
})
