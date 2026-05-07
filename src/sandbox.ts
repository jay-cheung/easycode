import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import type { AgentMode } from "./message"

export type BashResult = {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
}

export type SandboxOptions = {
  timeoutMs?: number
  maxOutputBytes?: number
}

export class SandboxBoundaryError extends Error {
  constructor(target: string, root: string) {
    super(`Path escapes project root: ${target} is outside ${root}`)
    this.name = "SandboxBoundaryError"
  }
}

export class SandboxCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxCommandError"
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

let nativeWriteSandboxAvailable: Promise<boolean> | undefined

function truncateBytes(input: string, maxBytes: number) {
  if (Buffer.byteLength(input) <= maxBytes) return { text: input, truncated: false }
  const buffer = Buffer.from(input)
  return { text: buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8"), truncated: true }
}

export function isDangerousCommand(command: string) {
  const text = command.trim().toLowerCase()
  return /(^|\s)rm\s+-rf(\s|$|\/)/.test(text) || text.startsWith("sudo ") || text.startsWith("git push") || text.startsWith("docker ") || /curl\b[\s\S]*\|[\s\S]*(sh|bash)\b/.test(text) || /chmod\s+-r\s+\//.test(text)
}

export function isReadOnlyCommand(command: string) {
  const text = command.trim()
  if (!text || /[;&><`$]/.test(text)) return false
  return ["pwd", "ls", "find", "rg", "grep", "cat", "wc", "git status", "git diff", "git log", "sed -n"].some((prefix) => text === prefix || text.startsWith(`${prefix} `))
}

function shellPathReferences(command: string) {
  const matches = command.matchAll(/(^|[\s"'=<>])((?:\.\.?[/\\]|\/)[^\s"'<>;|&]*)/g)
  return [...matches].map((match) => match[2] ?? "")
}

function escapeSandboxString(input: string) {
  return input.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function macosSandboxProfile(root: string) {
  return `(version 1)
(allow default)
(deny file-write* (require-not (subpath "${escapeSandboxString(root)}")))`
}

async function canUseNativeWriteSandbox() {
  if (process.platform !== "darwin") return false
  if (!nativeWriteSandboxAvailable) {
    nativeWriteSandboxAvailable = (async () => {
      const proc = Bun.spawn([SANDBOX_EXEC, "-p", "(version 1) (allow default)", "true"], { stdout: "pipe", stderr: "pipe" })
      return (await proc.exited.catch(() => 1)) === 0
    })()
  }
  return nativeWriteSandboxAvailable
}

export class Sandbox {
  readonly root: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number

  constructor(root: string, options: SandboxOptions = {}) {
    this.root = path.resolve(root)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  contains(target: string) {
    const resolved = path.resolve(target)
    const relative = path.relative(this.root, resolved)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  resolve(target = ".") {
    const resolved = path.resolve(this.root, target)
    if (!this.contains(resolved)) throw new SandboxBoundaryError(resolved, this.root)
    return resolved
  }

  async readFile(filePath: string) {
    return Bun.file(this.resolve(filePath)).text()
  }

  async writeFile(filePath: string, content: string) {
    const resolved = this.resolve(filePath)
    await mkdir(path.dirname(resolved), { recursive: true })
    await Bun.write(resolved, content)
  }

  async list(dirPath = ".") {
    return (await readdir(this.resolve(dirPath), { withFileTypes: true })).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort((left, right) => left.localeCompare(right))
  }

  async grep(input: { query: string; dir?: string }) {
    const root = this.resolve(input.dir ?? ".")
    const matches: string[] = []
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if ([".git", "node_modules"].includes(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        const text = await Bun.file(full).text().catch(() => "")
        if (text.includes(input.query)) matches.push(path.relative(this.root, full))
      }
    }
    await walk(root)
    return matches.sort((left, right) => left.localeCompare(right))
  }

  async execute(input: { command: string; cwd?: string; timeoutMs?: number }, mode: AgentMode = "build"): Promise<BashResult> {
    if (mode === "plan" && !isReadOnlyCommand(input.command)) throw new SandboxCommandError(`Plan mode blocks side-effectful command: ${input.command}`)
    if (isDangerousCommand(input.command)) throw new SandboxCommandError(`Dangerous command denied: ${input.command}`)
    const cwd = this.resolve(input.cwd ?? ".")
    for (const reference of shellPathReferences(input.command)) {
      const resolved = path.resolve(cwd, reference)
      if (!this.contains(resolved)) throw new SandboxCommandError(`Command path escapes project root: ${reference}`)
    }

    const started = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, input.timeoutMs ?? this.timeoutMs)

    const shell = process.platform === "win32" ? "cmd.exe" : "bash"
    const shellFlag = process.platform === "win32" ? "/c" : "-lc"
    const command = process.platform !== "win32" && (await canUseNativeWriteSandbox()) ? [SANDBOX_EXEC, "-p", macosSandboxProfile(this.root), shell, shellFlag, input.command] : [shell, shellFlag, input.command]
    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    })
    const [stdoutRaw, stderrRaw] = await Promise.all([
      new Response(proc.stdout).text().catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
      new Response(proc.stderr).text().catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
    ])
    const exitCode = await proc.exited.catch(() => null)
    clearTimeout(timer)
    const stdout = truncateBytes(stdoutRaw, this.maxOutputBytes)
    const stderr = truncateBytes(stderrRaw, this.maxOutputBytes)
    return { command: input.command, exitCode, stdout: stdout.text, stderr: stderr.text, timedOut, truncated: stdout.truncated || stderr.truncated, durationMs: Date.now() - started }
  }
}
