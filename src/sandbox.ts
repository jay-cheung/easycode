import path from "node:path"
import os from "node:os"
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import type { AgentMode } from "./message"
import { isHardDeniedBashCommand } from "./bash-safety"

export type BashResult = {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutDiagnostics?: string[]
  stderrDiagnostics?: string[]
  stdoutRawLength?: number
  stderrRawLength?: number
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  durationMs: number
  nativeWriteSandbox: boolean
  sandboxBypassed: boolean
  pathBoundaryBypassed: boolean
  error?: string
  pathBoundaryReference?: string
  pathBoundaryResolved?: string
  pathBoundaryRoot?: string
  allowedScratchRoots?: string[]
  recoveryHint?: string
}

export type SandboxOptions = {
  timeoutMs?: number
  maxOutputBytes?: number
  backend?: "local" | "docker"
  dockerImage?: string
  network?: "allow" | "deny"
}

export type SandboxExecuteOptions = {
  bypassNativeWriteSandbox?: boolean
  bypassPathBoundary?: boolean
  signal?: AbortSignal
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

export class SandboxPathEscapeError extends SandboxCommandError {
  readonly reference: string
  readonly resolved: string
  readonly root: string

  constructor(reference: string, resolved: string, root: string) {
    super(`Command path escapes project root: ${reference}`)
    this.name = "SandboxPathEscapeError"
    this.reference = reference
    this.resolved = resolved
    this.root = root
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

let nativeWriteSandboxAvailable: Promise<boolean> | undefined

type PipeSubprocess = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: string): void
}

function truncateBytes(input: string, maxBytes: number) {
  const diagnostics = keyDiagnosticLines(input)
  if (Buffer.byteLength(input) <= maxBytes) return { text: input, truncated: false, diagnostics }
  const buffer = Buffer.from(input)
  return { text: buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8"), truncated: true, diagnostics }
}

function keyDiagnosticLines(text: string) {
  const pattern = /(error|failed|failure|exception|traceback|panic|fatal|denied|invalid|timeout|timed out|not found|permission|refused|assert)/i
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && pattern.test(line)))].slice(0, 8)
}

export function isDangerousCommand(command: string) {
  return isHardDeniedBashCommand(command)
}

export function isReadOnlyCommand(command: string) {
  const text = command.trim()
  if (!text || /[;&><`$]/.test(text)) return false
  return ["pwd", "ls", "find", "rg", "grep", "cat", "wc", "git status", "git diff", "git log", "sed -n"].some((prefix) => text === prefix || text.startsWith(`${prefix} `))
}

export function isNetworkCommand(command: string) {
  const text = command.trim().toLowerCase()
  return /\b(curl|wget|nc|ncat|telnet|ssh|scp|ftp|rsync)\b/.test(text) || /\b(?:bunx?|npm|pnpm|yarn|pip|uv|cargo|go)\s+(?:install|add|get|update|dlx|create)\b/.test(text)
}

function shellPathReferences(command: string) {
  const matches = command.matchAll(/(^|[\s"'=<>])((?:~(?:[/\\]|$)|\.\.?[/\\]|\/)[^\s"'<>;|&]*)/g)
  return [...matches].map((match) => match[2] ?? "")
}

function resolveShellPathReference(cwd: string, reference: string) {
  const expanded = reference === "~" || reference.startsWith("~/") || reference.startsWith("~\\")
    ? path.join(os.homedir(), reference.slice(1))
    : reference
  return path.resolve(cwd, expanded)
}

function escapeSandboxString(input: string) {
  return input.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function normalizeSandboxProfilePath(input: string) {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"))
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

function sandboxProfilePathVariants(input: string) {
  const normalized = normalizeSandboxProfilePath(input)
  const variants = new Set<string>([normalized])
  if (normalized.startsWith("/private/")) variants.add(normalized.slice("/private".length))
  else if (normalized.startsWith("/")) variants.add(`/private${normalized}`)
  return [...variants]
}

function macosSessionTempWriteRoots() {
  const tmpdir = normalizeSandboxProfilePath(os.tmpdir())
  const parent = path.posix.dirname(tmpdir)
  if (!/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+$/.test(parent)) return []
  return sandboxProfilePathVariants(parent)
}

export function allowedExternalPathRoots() {
  return [
    ...sandboxProfilePathVariants("/tmp"),
    ...sandboxProfilePathVariants(os.tmpdir()),
    ...macosSessionTempWriteRoots(),
  ].filter((value, index, values) => values.indexOf(value) === index)
}

export function allowedExternalPathDescription() {
  return [...allowedExternalPathRoots(), "/dev/null", "/private/dev/null"]
}

function isAllowedExternalCommandPath(target: string) {
  const normalized = normalizeSandboxProfilePath(target)
  if (normalized === "/dev/null" || normalized === "/private/dev/null") return true
  return allowedExternalPathRoots().some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

export function macosSandboxProfile(root: string) {
  const writableRoots = [
    ...sandboxProfilePathVariants(root).map((value) => `(subpath "${escapeSandboxString(value)}")`),
    ...sandboxProfilePathVariants("/tmp").map((value) => `(subpath "${escapeSandboxString(value)}")`),
    ...macosSessionTempWriteRoots().map((value) => `(subpath "${escapeSandboxString(value)}")`),
  ]
  return `(version 1)
(allow default)
(deny file-write*
  (require-all
${writableRoots.map((rule) => `    (require-not ${rule})`).join("\n")}
    (require-not (literal "/dev/null"))
    (require-not (literal "/private/dev/null"))))`
}

export function looksLikeNativeSandboxDenial(result: Pick<BashResult, "exitCode" | "stderr" | "stdout" | "nativeWriteSandbox" | "sandboxBypassed">) {
  if (!result.nativeWriteSandbox || result.sandboxBypassed || result.exitCode === 0) return false
  const output = `${result.stderr}\n${result.stdout}`
  return /Operation not permitted|deny\(|sandbox-exec|sandbox_apply/i.test(output)
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
  readonly backend: "local" | "docker"
  readonly dockerImage: string
  readonly network: "allow" | "deny"

  constructor(root: string, options: SandboxOptions = {}) {
    this.root = path.resolve(root)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.backend = options.backend ?? sandboxBackendFromEnv()
    this.dockerImage = options.dockerImage ?? process.env.EASYCODE_SANDBOX_DOCKER_IMAGE ?? "oven/bun:1"
    this.network = options.network ?? (process.env.EASYCODE_SANDBOX_NETWORK === "deny" ? "deny" : "allow")
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

  async deleteFile(filePath: string) {
    await rm(this.resolve(filePath))
  }

  async moveFile(fromPath: string, toPath: string) {
    const from = this.resolve(fromPath)
    const to = this.resolve(toPath)
    await mkdir(path.dirname(to), { recursive: true })
    await rename(from, to)
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

  async execute(input: { command: string; cwd?: string; timeoutMs?: number }, mode: AgentMode = "build", options: SandboxExecuteOptions = {}): Promise<BashResult> {
    if (mode === "plan" && !isReadOnlyCommand(input.command)) throw new SandboxCommandError(`Plan mode blocks side-effectful command: ${input.command}`)
    if (isDangerousCommand(input.command)) throw new SandboxCommandError(`Dangerous command denied: ${input.command}`)
    if (this.network === "deny" && isNetworkCommand(input.command)) throw new SandboxCommandError(`Network command denied by sandbox policy: ${input.command}`)
    const cwd = this.resolve(input.cwd ?? ".")
    if (!options.bypassPathBoundary) {
      for (const reference of shellPathReferences(input.command)) {
        const resolved = resolveShellPathReference(cwd, reference)
        if (!this.contains(resolved) && !isAllowedExternalCommandPath(resolved)) throw new SandboxPathEscapeError(reference, resolved, this.root)
      }
    }

    const started = Date.now()
    const controller = new AbortController()
    let proc: PipeSubprocess | undefined
    let timedOut = false
    let cancelled = Boolean(options.signal?.aborted)
    const onAbort = () => {
      cancelled = true
      controller.abort()
      proc?.kill("SIGTERM")
    }
    if (cancelled) return cancelledBashResult(input.command, started)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      proc?.kill("SIGTERM")
    }, input.timeoutMs ?? this.timeoutMs)

    const shell = process.platform === "win32" ? "cmd.exe" : "bash"
    const shellFlag = process.platform === "win32" ? "/c" : "-c"
    const nativeWriteSandbox = this.backend === "local" && process.platform !== "win32" && !options.bypassNativeWriteSandbox && (await canUseNativeWriteSandbox())
    if (cancelled) {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      return cancelledBashResult(input.command, started)
    }
    const command = commandForBackend(this, cwd, input.command, shell, shellFlag, nativeWriteSandbox)
    proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    }) as PipeSubprocess
    // When cancelled, race pipe reads + exit code against a 3-second kill-grace timeout
    const pipePromise = Promise.all([
      new Response(proc.stdout).text().catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
      new Response(proc.stderr).text().catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
    ])
    const exitPromise = proc.exited.catch(() => null)

    let stdoutRaw: string
    let stderrRaw: string
    let exitCode: number | null
    let killGraceExpired = false

    if (cancelled) {
      const grace = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("kill grace")), 3000),
      )
      try {
        ;[stdoutRaw, stderrRaw] = await Promise.race([pipePromise, grace])
        exitCode = await Promise.race([exitPromise, grace])
      } catch {
        killGraceExpired = true
        timedOut = true
        stdoutRaw = ""
        stderrRaw = "Command did not terminate within 3 seconds of cancel signal."
        exitCode = null
      }
    } else {
      ;[stdoutRaw, stderrRaw] = await pipePromise
      exitCode = await exitPromise
    }
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
    const stdout = truncateBytes(redactSensitiveEnvValues(stdoutRaw), this.maxOutputBytes)
    const stderr = truncateBytes(redactSensitiveEnvValues(stderrRaw), this.maxOutputBytes)
    return {
      command: input.command,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutDiagnostics: stdout.diagnostics,
      stderrDiagnostics: stderr.diagnostics,
      stdoutRawLength: redactSensitiveEnvValues(stdoutRaw).length,
      stderrRawLength: redactSensitiveEnvValues(stderrRaw).length,
      timedOut,
      cancelled,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
      nativeWriteSandbox,
      sandboxBypassed: Boolean(options.bypassNativeWriteSandbox),
      pathBoundaryBypassed: Boolean(options.bypassPathBoundary),
    }
  }
}

function commandForBackend(sandbox: Sandbox, cwd: string, command: string, shell: string, shellFlag: string, nativeWriteSandbox: boolean) {
  if (sandbox.backend === "docker") {
    const relativeCwd = path.relative(sandbox.root, cwd) || "."
    const dockerNetwork = sandbox.network === "deny" ? ["--network", "none"] : []
    return [
      "docker",
      "run",
      "--rm",
      ...dockerNetwork,
      "-v",
      `${sandbox.root}:/workspace`,
      "-w",
      path.posix.join("/workspace", relativeCwd.split(path.sep).join("/")),
      sandbox.dockerImage,
      shell,
      shellFlag,
      command,
    ]
  }
  return nativeWriteSandbox ? [SANDBOX_EXEC, "-p", macosSandboxProfile(sandbox.root), shell, shellFlag, command] : [shell, shellFlag, command]
}

function sandboxBackendFromEnv(): "local" | "docker" {
  return process.env.EASYCODE_SANDBOX_BACKEND === "docker" ? "docker" : "local"
}

function redactSensitiveEnvValues(text: string) {
  let output = text
  for (const value of sensitiveEnvValues()) output = output.split(value).join("[redacted]")
  return output
}

function sensitiveEnvValues(env: NodeJS.ProcessEnv = process.env) {
  return Object.entries(env)
    .filter(([key, value]) => Boolean(value) && /(?:key|token|secret|password|credential)/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.length >= 6)
}

function cancelledBashResult(command: string, started: number): BashResult {
  return {
    command,
    exitCode: null,
    stdout: "",
    stderr: "Command cancelled by user.",
    stdoutDiagnostics: [],
    stderrDiagnostics: [],
    stdoutRawLength: 0,
    stderrRawLength: "Command cancelled by user.".length,
    timedOut: false,
    cancelled: true,
    truncated: false,
    durationMs: Date.now() - started,
    nativeWriteSandbox: false,
    sandboxBypassed: false,
    pathBoundaryBypassed: false,
  }
}
