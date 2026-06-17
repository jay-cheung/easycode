import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-cli-"))
}

async function readPipe(pipe: ReadableStream<Uint8Array> | null, onChunk?: (text: string) => void) {
  if (!pipe) return ""
  const reader = pipe.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
    onChunk?.(text)
  }
  return text
}

async function waitForOutput(getText: () => string, expected: string, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (getText().includes(expected)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for output: ${expected}\nCurrent output:\n${getText()}`)
}

async function waitForOutputCount(getText: () => string, expected: string, count: number, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const matches = getText().split(expected).length - 1
    if (matches >= count) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for output count: ${expected} x${count}\nCurrent output:\n${getText()}`)
}

async function spawnCliForcedTTY(
  args: string[],
  steps: Array<{ waitFor: string; send: string; timeoutMs?: number }>,
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, EASYCODE_TEST_FORCE_TTY: "1" },
  })

  let stdout = ""
  let stderr = ""
  const stdoutDone = readPipe(child.stdout, (text) => {
    stdout = text
  })
  const stderrDone = readPipe(child.stderr, (text) => {
    stderr = text
  })

  for (const step of steps) {
    await waitForOutput(() => stdout, step.waitFor, step.timeoutMs)
    child.stdin.write(step.send)
  }
  child.stdin.end()
  const [status, finalStdout, finalStderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
  stdout = finalStdout
  stderr = finalStderr
  return { stdout, stderr, status }
}

describe("cli integration", () => {
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
    const cleanEnv = { ...process.env }
    cleanEnv.TAVILY_API_KEY = ""
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: cleanEnv,
    })
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Starting new session: default")
    expect(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).exists()).toBe(true)
    expect(stdout).toContain("Live web search is not configured.")
    expect(stdout).toContain("TAVILY_API_KEY")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session startup skips web search setup hint when tavily is configured", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TAVILY_API_KEY: "tavily-token" },
    })
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).not.toContain("Live web search is not configured.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session startup skips web search setup hint when tavily apiKey is configured in websearch.json", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "websearch.json"), JSON.stringify({
      defaultEngine: "tavily",
      engines: [{ name: "tavily", type: "tavily", apiKey: "tvly-inline" }],
    }))
    const cleanEnv = { ...process.env }
    cleanEnv.TAVILY_API_KEY = ""
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: cleanEnv,
    })
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).not.toContain("Live web search is not configured.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("forced tty startup covers interactive provider and tavily setup prompts", async () => {
    const root = await tmpdir()
    const home = await tmpdir()
    const result = await spawnCliForcedTTY(["build", "--root", root], [
      { waitFor: "Language [1-6 or code, default: en]: ", send: "zh\n", timeoutMs: 5_000 },
      { waitFor: "Would you like to set up environment variables now? (Y/n): ", send: "n\n", timeoutMs: 5_000 },
      { waitFor: "Would you like to configure TAVILY_API_KEY in ~/.easycode/.env now? (Y/n): ", send: "n\n", timeoutMs: 5_000 },
      { waitFor: "easycode> ", send: ":exit\n", timeoutMs: 5_000 },
    ], {
      ...process.env,
      HOME: home,
      EASYCODE_LANG: "",
      EASYCODE_PROVIDER: "",
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_MODEL: "",
      OPENAI_API_KEY: "",
      OPENAI_MODEL: "",
      OPENAI_COMPAT_API_KEY: "",
      OPENAI_COMPAT_API_URL: "",
      OPENAI_COMPAT_MODEL: "",
      TAVILY_API_KEY: "",
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Language [1-6 or code, default: en]:")
    expect(result.stdout).toContain("UI language saved as zh (中文)")
    expect(result.stdout).toContain("Would you like to set up environment variables now? (Y/n):")
    expect(result.stdout).toContain("Would you like to configure TAVILY_API_KEY in ~/.easycode/.env now? (Y/n):")
    expect(result.stdout).toContain("开始新会话：default")
    expect(result.stdout).toContain("尚未配置实时联网搜索。")
    expect(result.stdout).toContain("~/.easycode/.env")
    expect(result.stderr).toBe("")
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("forced tty startup can save TAVILY_API_KEY to the global easycode env", async () => {
    const root = await tmpdir()
    const home = await tmpdir()
    const result = await spawnCliForcedTTY(["build", "--provider", "fake", "--root", root], [
      { waitFor: "Language [1-6 or code, default: en]: ", send: "en\n", timeoutMs: 5_000 },
      { waitFor: "Would you like to configure TAVILY_API_KEY in ~/.easycode/.env now? (Y/n): ", send: "\n", timeoutMs: 5_000 },
      { waitFor: "Tavily API key (tvly-, leave empty to skip): ", send: "tvly-pty-test\n", timeoutMs: 5_000 },
      { waitFor: "easycode> ", send: ":exit\n", timeoutMs: 5_000 },
    ], {
      ...process.env,
      HOME: home,
      EASYCODE_LANG: "",
      TAVILY_API_KEY: "",
    })
    const envPath = path.join(home, ".easycode", ".env")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Would you like to configure TAVILY_API_KEY in ~/.easycode/.env now? (Y/n):")
    expect(result.stdout).toContain(`Configuration saved to ${envPath}`)
    expect(result.stdout).not.toContain("Configure Tavily with TAVILY_API_KEY.")
    expect(await Bun.file(envPath).text()).toContain("TAVILY_API_KEY=tvly-pty-test")
    expect(result.stderr).toBe("")
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("top-level cli errors are friendly", async () => {
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "unknown-provider"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("easycode failed: Unknown provider: unknown-provider.")
    expect(stderr).not.toContain("src/cli.ts")
    expect(stderr).not.toContain("$bunfs")
    expect(stderr).not.toContain("\n    at ")
  })

  test("session startup lets users choose or create when sessions exist", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "sessions"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "sessions", "alpha.json"), JSON.stringify({
      id: "alpha",
      messages: [],
      settings: { provider: "fake", language: "zh", thinking: true, effort: "high", selectedSkills: [], pendingSkillLoads: [] },
      updatedAt: 100,
    }, null, 2))
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

  test("session command lists saved sessions and marks the current one", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "sessions"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "sessions", "alpha.json"), JSON.stringify({ id: "alpha", messages: [{ id: "m1", role: "user", parts: [], createdAt: 1 }], updatedAt: 100 }, null, 2))
    await Bun.write(path.join(root, ".easycode", "sessions", "beta.json"), JSON.stringify({ id: "beta", messages: [], updatedAt: 200 }, null, 2))

    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("1\n/sessions\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Saved sessions:")
    expect(stdout).toContain("1. beta (current) - 0 messages")
    expect(stdout).toContain("2. alpha - 1 message")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session switch command swaps active session state", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "sessions"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "sessions", "alpha.json"), JSON.stringify({
      id: "alpha",
      messages: [],
      settings: { provider: "fake", language: "zh", thinking: true, effort: "high", selectedSkills: [], pendingSkillLoads: [] },
      updatedAt: 100,
    }, null, 2))
    await Bun.write(path.join(root, ".easycode", "sessions", "beta.json"), JSON.stringify({
      id: "beta",
      messages: [],
      settings: { provider: "fake", language: "en", thinking: true, effort: "high", selectedSkills: [], pendingSkillLoads: [] },
      updatedAt: 200,
    }, null, 2))

    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("1\n/session switch alpha\n/settings\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("已切换到会话：alpha")
    expect(stdout).toContain("language: zh (中文)")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session delete command archives memory and removes related files", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "sessions"), { recursive: true })
    await mkdir(path.join(root, ".easycode", "logs", "sessions"), { recursive: true })
    await mkdir(path.join(root, ".easycode", "plans", "beta"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "sessions", "alpha.json"), JSON.stringify({
      id: "alpha",
      messages: [],
      settings: { provider: "fake", language: "zh", thinking: true, effort: "high", selectedSkills: [], pendingSkillLoads: [] },
      updatedAt: 100,
    }, null, 2))
    await Bun.write(path.join(root, ".easycode", "sessions", "beta.json"), JSON.stringify({
      id: "beta",
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "summarize beta work" }], createdAt: 1 },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "beta summary" }], createdAt: 2 },
      ],
      summary: "beta summary",
      updatedAt: 200,
    }, null, 2))
    await Bun.write(path.join(root, ".easycode", "logs", "sessions", "beta.jsonl"), "{\"type\":\"data\"}\n")
    await Bun.write(path.join(root, ".easycode", "logs", "sessions", "beta.txt"), "transcript\n")
    await Bun.write(path.join(root, ".easycode", "plans", "beta", "1.md"), "plan")

    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("1\n/session delete beta\n/sessions\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("已删除会话：beta")
    expect(stdout).toContain("1. alpha（当前） - 0 条消息")
    expect(await Bun.file(path.join(root, ".easycode", "sessions", "beta.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, ".easycode", "logs", "sessions", "beta.jsonl")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, ".easycode", "logs", "sessions", "beta.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, ".easycode", "plans", "beta", "1.md")).exists()).toBe(false)
    const memory = JSON.parse(await Bun.file(path.join(root, ".easycode", "memory.json")).text()) as { records: Array<{ text: string }> }
    expect(memory.records.at(-1)?.text).toContain("Deleted session \"beta\".")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("task command is no longer available", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("/task checkpoint Fix the login bug\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("Unknown command: /task")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session startup ignores legacy task_state memory records", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "memory.json"), JSON.stringify({
      records: [{
        id: "mem_task_1",
        kind: "task_state",
        text: "Refactor auth module",
        tags: ["task", "checkpoint"],
        scope: { topics: ["task_checkpoint"] },
        createdAt: Date.now(),
      }],
    }))
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
    expect(stdout).not.toContain("Active task checkpoints:")
    expect(stdout).not.toContain("Refactor auth module")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("session switch does not revive saved active plan state", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "sessions"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "sessions", "alpha.json"), JSON.stringify({
      id: "alpha",
      messages: [],
      ledger: {
        current: [
          { id: "cp1", kind: "checkpoint", subject: "current_plan_id", value: "plan_alpha", status: "current", updatedAtTurn: 1 },
          { id: "cp2", kind: "checkpoint", subject: "current_plan_step", value: "step_1", status: "current", updatedAtTurn: 1 },
          { id: "cp3", kind: "checkpoint", subject: "plan_lifecycle_status", value: "running", status: "current", updatedAtTurn: 1 },
        ],
      },
      settings: { provider: "fake", language: "zh", thinking: true, effort: "high", selectedSkills: [], pendingSkillLoads: [] },
      updatedAt: 100,
    }, null, 2))
    await Bun.write(path.join(root, ".easycode", "sessions", "beta.json"), JSON.stringify({
      id: "beta",
      messages: [],
      settings: { provider: "fake", language: "en", thinking: true, effort: "high", selectedSkills: [], pendingSkillLoads: [] },
      updatedAt: 200,
    }, null, 2))
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("1\n/session switch alpha\n/goal status\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(status).toBe(0)
    expect(stdout).toContain("No active goal.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("lang command updates session language and global preference", async () => {
    const root = await tmpdir()
    const home = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, EASYCODE_LANG: "en" },
    })
    child.stdin.write("/lang zh\n/settings\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("界面语言已切换为 zh (中文)")
    expect(stdout).toContain("language: zh (中文)")
    expect(await Bun.file(path.join(home, ".easycode", ".env")).text()).toContain("EASYCODE_LANG=zh")
    expect(JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text()).settings.language).toBe("zh")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test("tui session covers settings, sessions, and prompt rendering", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode", "sessions"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "sessions", "alpha.json"), JSON.stringify({ id: "alpha", messages: [{ id: "m1", role: "user", parts: [], createdAt: 1 }], updatedAt: 100 }, null, 2))
    await Bun.write(path.join(root, ".easycode", "sessions", "beta.json"), JSON.stringify({ id: "beta", messages: [], updatedAt: 200 }, null, 2))

    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("1\n/settings\n/sessions\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("EasyCode TUI")
    expect(stdout).toContain("/help /settings /plan /goal /sessions")
    expect(stdout).toContain("[Settings]")
    expect(stdout).toContain("provider: fake")
    expect(stdout).toContain("[Sessions]")
    expect(stdout).toContain("1. beta (current) - 0 messages")
    expect(stdout).toContain("easycode> ")
    expect(stderr).toBe("")
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
    child.stdin.write("loop forever\n\n:exit\n")
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
    let stdout = ""
    let stderr = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr, (text) => {
      stderr = text
    })
    child.stdin.write("delayed answer\n")
    await waitForOutput(() => stdout, "Type /cancel to stop this run", 3_000)
    child.stdin.write("queued-ok\n")
    await waitForOutput(() => stdout, "Delayed done.", 3_000)
    await waitForOutput(() => stdout, "Queued done.", 3_000)
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [status, finalStdout, finalStderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    stderr = finalStderr
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
    child.stdin.write("\n")
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

  test("session saves cancellation state before exiting on SIGINT", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--no-tui", "--session", "sigint", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    let stderr = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr, (text) => {
      stderr = text
    })

    child.stdin.write("delayed answer\n")
    await waitForOutput(() => stdout, "Type /cancel to stop this run", 3_000)
    process.kill(child.pid, "SIGINT")

    const [status, finalStdout, finalStderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    stderr = finalStderr

    expect(status).toBe(0)
    expect(stdout).toContain("Run cancelled by user.")
    expect(stderr).toBe("")

    const session = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "sigint.json")).text()) as { messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }> }
    expect(session.messages.map((message) => message.role)).toContain("assistant")
    expect(JSON.stringify(session.messages)).toContain("Run cancelled by user.")
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
    let stdout = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr)
    child.stdin.write("Read env configuration\n")
    await waitForOutput(() => stdout, "Allow read for .env?", 3_000)
    child.stdin.write("n\n:exit\n")
    child.stdin.end()
    const [status, finalStdout, stderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    expect(status).toBe(0)
    expect(stdout).toContain("Allow read for .env?")
    expect(stdout).not.toContain("SECRET=hidden")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("tui preserves permission prompts and cancellation path", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, ".env"), "SECRET=hidden\n")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr)
    child.stdin.write("Read env configuration\n")
    await waitForOutput(() => stdout, "Allow read for .env?", 3_000)
    child.stdin.write("/cancel\n")
    await waitForOutput(() => stdout, "TUI: Cancelling current run...", 3_000)
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [status, finalStdout, stderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    expect(status).toBe(0)
    expect(stdout).toContain("[Permission]")
    expect(stdout).toContain("Allow read for .env?")
    expect(stdout).toContain("TUI: Cancelling current run...")
    expect(stdout).not.toContain("SECRET=hidden")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("tui single-run mode renders the same run timeline", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "进行 20 轮短问答", "--provider", "fake", "--tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("EasyCode TUI")
    expect(stdout).toContain("● Model")
    expect(stdout).toContain("● Answer")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("tui unified mode keeps the approval prompt on the planning workflow", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    let stderr = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr, (text) => {
      stderr = text
    })
    child.stdin.write("/plan plan-exit\n")
    await waitForOutput(() => stdout, "[Plan] [A]pprove & execute", 5_000)
    child.stdin.write("r\n:exit\n")
    child.stdin.end()
    const [status, finalStdout, finalStderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    stderr = finalStderr
    expect(status).toBe(0)
    expect(stdout).toContain("[Plan] [A]pprove & execute")
    expect(stdout).toContain("[status] plan approval")
    expect(stdout).toContain("<proposed_plan>")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("ordinary interactive prompts stay in build mode and execute directly", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--logger", "--no-tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr)
    child.stdin.write("queued-ok\n:exit\n")
    child.stdin.end()
    const [status, finalStdout, stderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout

    expect(status).toBe(0)
    expect(stdout).toContain("Queued done.")
    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.jsonl")).text()
    expect(logText).toContain("\"name\":\"provider.input\"")
    expect(logText).toContain("\"mode\":\"build\"")
    expect(logText).toContain("\"prompt\":\"queued-ok\"")
    expect(logText).not.toContain("\"mode\":\"plan\",\"prompt\":\"queued-ok\"")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("non-low-risk default approval keeps [A] behavior and logs user_default", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--logger", "--no-tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr)
    child.stdin.write("/plan high-risk-plan\n")
    await waitForOutput(() => stdout, "[A]pprove & execute", 5_000)
    child.stdin.write("\n:exit\n")
    child.stdin.end()
    const [status, finalStdout, stderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout

    expect(status).toBe(0)
    expect(stdout).toContain("[A]pprove & execute")
    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.jsonl")).text()
    expect(logText).toContain("\"name\":\"plan.approval\"")
    expect(logText).toContain("\"approval_source\":\"user_default\"")
    expect(logText).toContain("\"lowRisk\":false")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 15_000 })

  test("low-risk plans auto-approve and log low_risk_auto", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--logger", "--no-tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("/plan low-risk-plan\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(status).toBe(0)
    expect(stdout).toContain("Low-risk plan detected")
    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.jsonl")).text()
    expect(logText).toContain("\"approval_source\":\"low_risk_auto\"")
    expect(logText).toContain("\"lowRisk\":true")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 15_000 })

  test("goal mode auto-plans, delegates a subagent step, and completes", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--logger", "--no-tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr)
    child.stdin.write("/goal goal-delegated-e2e\n")
    await waitForOutput(() => stdout, "Goal completed.", 8_000)
    child.stdin.write(":exit\n")
    child.stdin.end()

    const [status, finalStdout, stderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    expect(status).toBe(0)
    expect(stdout).toContain("Goal started.")
    expect(stdout).toContain("Goal Acceptance Recorded")
    expect(stdout).toContain("Goal delegated e2e plan")
    expect(stdout).toContain("delegate_subagent")
    expect(stdout).toContain("plan_step_complete")
    expect(stdout).toContain("Reviewer check: delegated evidence is complete")
    expect(stdout).toContain("Goal completed.")
    expect(stdout).toContain("goal-delegated-e2e completed after delegated inspection.")
    expect(stderr).toBe("")

    const planState = JSON.parse(await Bun.file(path.join(root, ".easycode", "plans", "default", "plan_goal_delegated_e2e.json")).text())
    expect(planState.plan.lowRisk).toBe(true)
    expect(planState.plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "explorer" })
    expect(planState.checkpoint.status).toBe("completed")

    const session = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "completed" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_objective", value: "goal-delegated-e2e" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_iteration", value: "1" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_acceptance_criteria", value: expect.stringContaining("delegated inspection slice") }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_completion_checks", value: expect.stringContaining("delegated result") }))

    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.jsonl")).text()
    expect(logText).toContain("\"name\":\"provider.output\"")
    expect(logText).toContain("\"name\":\"goal.started\"")
    expect(logText).toContain("\"name\":\"goal.definition\"")
    expect(logText).toContain("\"name\":\"goal.planning\"")
    expect(logText).toContain("\"name\":\"goal.executing\"")
    expect(logText).toContain("\"name\":\"goal.reviewing\"")
    expect(logText).toContain("\"name\":\"goal.completed\"")
    expect(logText).toContain("goal_set_acceptance")
    expect(logText).toContain("plan_exit")
    expect(logText).toContain("delegate_subagent")
    expect(logText).toContain("plan_step_complete")
    expect(logText).toContain("goal_complete")

    const subagentLogText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.subagents.jsonl")).text()
    expect(subagentLogText).toContain("\"name\":\"subagent.request\"")
    expect(subagentLogText).toContain("\"role\":\"explorer\"")
    expect(subagentLogText).toContain("\"role\":\"reviewer\"")
    expect(subagentLogText).toContain("Found export function add")

    await rm(root, { recursive: true, force: true })
  }, { timeout: 15_000 })

  test("goal mode can review a finished slice, replan automatically, and complete on a later slice", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
    await Bun.write(path.join(root, "src", "sub.ts"), "export function sub(a: number, b: number) {\n  return a - b\n}\n")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--logger", "--no-tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr)
    child.stdin.write("/goal goal-multi-slice-e2e\n")
    await waitForOutput(() => stdout, "Goal completed.", 8_000)
    child.stdin.write(":exit\n")
    child.stdin.end()

    const [status, finalStdout, stderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    expect(status).toBe(0)
    expect(stdout).toContain("Goal started.")
    expect(stdout).toContain("Goal multi-slice e2e plan 1")
    expect(stdout).toContain("Goal multi-slice e2e plan 2")
    expect(stdout).toContain("Slice 1 explorer: src/add.ts")
    expect(stdout).toContain("Slice 2 explorer: src/sub.ts")
    expect(stdout).toContain("Reviewer check: slice 1 is complete, but the goal still needs one more bounded slice")
    expect(stdout).toContain("Reviewer check: slice 2 completed the remaining acceptance criteria")
    expect(stdout).toContain("Goal completed.")
    expect(stdout).toContain("goal-multi-slice-e2e completed after two delegated inspection slices.")
    expect(stderr).toBe("")

    const firstPlanState = JSON.parse(await Bun.file(path.join(root, ".easycode", "plans", "default", "plan_goal_multi_slice_e2e_1.json")).text())
    const secondPlanState = JSON.parse(await Bun.file(path.join(root, ".easycode", "plans", "default", "plan_goal_multi_slice_e2e_2.json")).text())
    expect(firstPlanState.plan.lowRisk).toBe(true)
    expect(secondPlanState.plan.lowRisk).toBe(true)
    expect(firstPlanState.checkpoint.status).toBe("completed")
    expect(secondPlanState.checkpoint.status).toBe("completed")

    const session = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "completed" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_objective", value: "goal-multi-slice-e2e" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_iteration", value: "2" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_complexity", value: "complex" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_first_slice", value: expect.stringContaining("Inspect src/add.ts first") }))

    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.jsonl")).text()
    expect(logText).toContain("\"name\":\"goal.reviewing\"")
    expect(logText.match(/"name":"goal\.planning"/g)?.length ?? 0).toBe(1)
    expect(logText.match(/"name":"goal\.reviewing"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(logText.match(/"name":"goal\.executing"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(logText).toContain("plan_goal_multi_slice_e2e_1")
    expect(logText).toContain("plan_goal_multi_slice_e2e_2")
    expect(logText).toContain("goal_complete")

    const subagentLogText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.subagents.jsonl")).text()
    expect(subagentLogText).toContain("\"role\":\"explorer\"")
    expect(subagentLogText).toContain("\"role\":\"reviewer\"")
    expect(subagentLogText).toContain("Inspect src/add.ts for goal-multi-slice-e2e slice 1")
    expect(subagentLogText).toContain("Inspect src/sub.ts for goal-multi-slice-e2e slice 2")
    expect(subagentLogText).toContain("Review goal-multi-slice-e2e slice 1 completion state")
    expect(subagentLogText).toContain("Review goal-multi-slice-e2e slice 2 completion state")

    await rm(root, { recursive: true, force: true })
  }, { timeout: 20_000 })

  test("goal mode turns broad audits into an immediate first bounded slice", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await Bun.write(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) {\n  return a + b\n}\n")
    await Bun.write(path.join(root, "src", "sub.ts"), "export function sub(a: number, b: number) {\n  return a - b\n}\n")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--provider", "fake", "--logger", "--no-tui", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr)
    child.stdin.write("/goal goal-incremental-audit-e2e\n")
    await waitForOutput(() => stdout, "Goal completed.", 8_000)
    child.stdin.write(":exit\n")
    child.stdin.end()

    const [status, finalStdout, stderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    expect(status).toBe(0)
    expect(stdout).toContain("Complexity: complex")
    expect(stdout).toContain("First slice: Inventory only the top-level source modules")
    expect(stdout).toContain("Goal incremental audit e2e plan 1")
    expect(stdout).toContain("Audit slice 1: top-level inventory")
    expect(stdout).toContain("Reviewer check: incremental audit slice 1 is complete")
    expect(stdout).toContain("goal-incremental-audit-e2e completed after one bounded inventory slice.")
    expect(stdout).not.toContain("Goal incremental audit e2e plan 2")
    expect(stderr).toBe("")

    const planState = JSON.parse(await Bun.file(path.join(root, ".easycode", "plans", "default", "plan_goal_incremental_audit_e2e_1.json")).text())
    expect(planState.plan.lowRisk).toBe(true)
    expect(planState.plan.steps).toHaveLength(1)
    expect(planState.plan.steps[0]).toMatchObject({ executorHint: "subagent", subagentRole: "explorer" })

    const session = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_status", value: "completed" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_complexity", value: "complex" }))
    expect(session.ledger.current).toContainEqual(expect.objectContaining({ subject: "current_goal_first_slice", value: "Inventory only the top-level source modules before any deeper module analysis." }))

    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.jsonl")).text()
    expect(logText.match(/"name":"goal\.planning"/g)?.length ?? 0).toBe(1)
    expect(logText).toContain("plan_goal_incremental_audit_e2e_1")

    await rm(root, { recursive: true, force: true })
  }, { timeout: 20_000 })

  test("tui single-run mode remains compatible with session logs", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "进行 20 轮短问答", "--provider", "fake", "--tui", "--logger", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("EasyCode TUI")
    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "once.jsonl")).text()
    expect(logText).toContain("\"name\":\"provider.input\"")
    expect(logText).toContain("\"name\":\"provider.output\"")
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
    let stdout = ""
    let stderr = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr, (text) => {
      stderr = text
    })
    child.stdin.write("/image pic.png\n")
    await waitForOutput(() => stdout, "Attached image:", 3_000)
    child.stdin.write("Describe it\n")
    await waitForOutput(() => stdout, "Image received.", 3_000)
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [status, finalStdout, finalStderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    stderr = finalStderr
    expect(status).toBe(0)
    expect(stdout).toContain("Attached image:")
    expect(stdout).toContain("● Thought")
    expect(stdout).toContain("I should inspect the attached image.")
    expect(stdout).toContain("● Answer")
    expect(stdout).toContain("Image received.")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("logger session renders like normal mode and writes session logs", async () => {
    const root = await tmpdir()
    await Bun.write(path.join(root, "pic.png"), "image-bytes")
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "build", "--provider", "fake", "--logger", "--root", root], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    let stderr = ""
    const stdoutDone = readPipe(child.stdout, (text) => {
      stdout = text
    })
    const stderrDone = readPipe(child.stderr, (text) => {
      stderr = text
    })
    child.stdin.write("/image pic.png\n")
    await waitForOutput(() => stdout, "Attached image:", 3_000)
    child.stdin.write("Describe it\n")
    await waitForOutput(() => stdout, "Image received.", 3_000)
    child.stdin.write(":exit\n")
    child.stdin.end()
    const [status, finalStdout, finalStderr] = await Promise.all([child.exited, stdoutDone, stderrDone])
    stdout = finalStdout
    stderr = finalStderr
    expect(status).toBe(0)
    expect(stdout).toContain("● Thought")
    expect(stdout).toContain("● Answer")
    expect(stdout).toContain("I should inspect the attached image.")
    expect(stdout).not.toContain("[easycode]")
    const logText = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.jsonl")).text()
    expect(logText).toContain("\"name\":\"provider.input\"")
    expect(logText).toContain("\"name\":\"provider.output\"")
    expect(logText).toContain("\"name\":\"provider.transcript\"")
    expect(logText).toContain("Describe it")
    expect(logText).toContain("Image received.")
    const transcript = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "default.txt")).text()
    expect(transcript).toContain("Turn 1\n\nInput\n\nSystem")
    expect(transcript).toContain("Cache\n\nn/a, cache hit: no")
    expect(transcript).toContain("provider reported cached tokens: 0")
    expect(transcript).toContain("Describe it")
    expect(transcript).toContain("Output\n\nAssistant")
    expect(transcript).toContain("Image received.")
    expect(transcript).toContain("exact cached text span: unavailable from provider")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })
})
