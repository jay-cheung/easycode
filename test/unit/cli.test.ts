import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { configuredStartupModel, fetchStartupModelChoices, loadEnvFile, mergeEnvText, missingProviderEnv, needsEnvSetup, parseArgs, parseEnvFile, recentStartupModels, selectStartupModel, startupModelChoices, startupProviders } from "../../src/cli"

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

  test("detects missing provider environment", () => {
    expect(needsEnvSetup(undefined, {})).toBe(true)
    expect(needsEnvSetup("fake", {})).toBe(false)
    expect(missingProviderEnv("deepseek", {})).toEqual(["DEEPSEEK_API_KEY"])
    expect(missingProviderEnv("openai", { OPENAI_API_KEY: "sk-test" })).toEqual([])
    expect(missingProviderEnv("openai-compatible", { OPENAI_COMPAT_API_KEY: "sk-test" })).toEqual(["OPENAI_COMPAT_API_URL"])
  })

  test("uses provider-specific startup model env keys", () => {
    expect(configuredStartupModel("openai", { OPENAI_MODEL: "gpt-5" })).toBe("gpt-5")
    expect(configuredStartupModel("deepseek", { DEEPSEEK_MODEL: "deepseek-chat" })).toBe("deepseek-chat")
    expect(configuredStartupModel("openai", { EASYCODE_MODEL: "fallback-only" })).toBeUndefined()
  })

  test("merges missing env values without replacing existing entries", () => {
    const merged = mergeEnvText("EASYCODE_PROVIDER=openai\nOPENAI_API_KEY=from-file\n", {
      EASYCODE_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "sk test",
      DEEPSEEK_MODEL: "deepseek-v4-pro",
    })

    expect(merged).toContain("EASYCODE_PROVIDER=openai")
    expect(merged).toContain("OPENAI_API_KEY=from-file")
    expect(merged).toContain('DEEPSEEK_API_KEY="sk test"')
    expect(merged).toContain("DEEPSEEK_MODEL=deepseek-v4-pro")
  })
})

describe("cli startup model selection", () => {
  test("lists only real startup providers", () => {
    expect(startupProviders()).toEqual(["deepseek", "openai", "openai-compatible"])
  })

  test("offers default startup model choices", () => {
    expect(startupModelChoices("deepseek")).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"])
    expect(startupModelChoices("openai")).toEqual(["gpt-5.5", "gpt-5.4"])
  })

  test("accepts preset index, preset name, and custom startup models", () => {
    expect(selectStartupModel("deepseek", "")).toBe("deepseek-v4-pro")
    expect(selectStartupModel("deepseek", "2")).toBe("deepseek-v4-flash")
    expect(selectStartupModel("openai", "gpt-5.4")).toBe("gpt-5.4")
    expect(selectStartupModel("openai", "gpt-5.5-mini")).toBe("gpt-5.5-mini")
  })

  test("keeps only the two most recent versions from live model lists", () => {
    expect(recentStartupModels("openai", ["gpt-5.4", "gpt-5", "gpt-5.5", "gpt-5.4-mini", "gpt-5.2"])).toEqual(["gpt-5.5", "gpt-5.4"])
    expect(recentStartupModels("deepseek", ["deepseek-chat", "deepseek-v4-flash", "deepseek-v3-pro", "deepseek-v4-pro"])).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"])
  })

  test("fetches startup model choices from provider model APIs", async () => {
    const models = await fetchStartupModelChoices(
      "openai",
      { OPENAI_API_KEY: "sk-test" },
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.1" }, { id: "gpt-5.5" }, { id: "gpt-5.4" }, { id: "gpt-5.5-codex" }] })),
    )
    expect(models).toEqual(["gpt-5.5", "gpt-5.4"])
  })

  test("falls back to bundled startup model choices when live fetch fails", async () => {
    const models = await fetchStartupModelChoices(
      "deepseek",
      { DEEPSEEK_API_KEY: "sk-test" },
      async () => new Response("boom", { status: 500 }),
    )
    expect(models).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"])
  })
})

describe("cli args", () => {
  test("session mode is the default and does not accept startup prompts", () => {
    expect(parseArgs([])).toMatchObject({ mode: "build", once: false, session: undefined, prompt: "" })
    expect(parseArgs(["build", "--provider", "fake"])).toMatchObject({ once: false, session: undefined, prompt: "" })
    expect(parseArgs(["--provider", "fake"])).toMatchObject({ mode: "build", once: false, provider: "fake", prompt: "" })
    expect(() => parseArgs(["build", "hello", "--session", "demo"])).toThrow("Session mode is interactive")
  })

  test("tui is enabled by default, --no-tui disables it", () => {
    expect(parseArgs(["build", "--provider", "fake", "--session", "demo"])).toMatchObject({ tui: true, once: false, session: "demo", prompt: "" })
    expect(parseArgs(["build", "--once", "hello", "--provider", "fake"])).toMatchObject({ tui: true, once: true, prompt: "hello" })
    expect(parseArgs(["build", "--no-tui", "--provider", "fake", "--session", "demo"])).toMatchObject({ tui: false, once: false, session: "demo", prompt: "" })
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

  test("parses --insecure and -k flags", () => {
    const originalValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    try {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      const args = parseArgs(["build", "--once", "hello", "--provider", "fake", "--insecure"])
      expect(args.insecure).toBe(true)
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED as any).toBe("0")

      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      const argsShort = parseArgs(["build", "--once", "hello", "--provider", "fake", "-k"])
      expect(argsShort.insecure).toBe(true)
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED as any).toBe("0")
      expect(argsShort.prompt).toBe("hello")
    } finally {
      if (originalValue === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalValue
      }
    }
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
    expect(stdout).toContain("/help /settings /sessions")
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
    child.stdin.write("Read env configuration\nn\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
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
    child.stdin.write("Read env configuration\n/cancel\n:exit\n")
    child.stdin.end()
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(status).toBe(0)
    expect(stdout).toContain("[Permission]")
    expect(stdout).toContain("Allow read for .env?")
    expect(stdout).toContain("TUI: Cancelling current run...")
    expect(stdout).not.toContain("SECRET=hidden")
    expect(stderr).toBe("")
    await rm(root, { recursive: true, force: true })
  })

  test("tui once mode renders the same run timeline", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "plan", "--once", "plan a harmless change", "--provider", "fake", "--tui", "--root", root], {
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

  test("tui plan mode keeps the approval prompt on the existing plan workflow", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "plan", "--provider", "fake", "--tui", "--root", root], {
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
    child.stdin.write("plan a harmless change\n")
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

  test("tui once mode remains compatible with session logs", async () => {
    const root = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "plan", "--once", "plan a harmless change", "--provider", "fake", "--tui", "--logger", "--root", root], {
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

  test("logger session renders like normal mode and writes session logs", async () => {
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
