import path from "node:path"
import { statSync } from "node:fs"
import { z } from "zod"
import { isDangerousCommand, looksLikeNativeSandboxDenial, SandboxPathEscapeError, type BashResult, type SandboxExecuteOptions } from "../sandbox"
import type { ToolContext, ToolResult } from "./registry"

const OptionalString = z.string().nullish().transform((value) => value ?? undefined)
const OptionalNumber = z.number().nullish().transform((value) => value ?? undefined)
export const BashInput = z.object({ command: z.string(), cwd: OptionalString, timeoutMs: OptionalNumber })

export type BashApproval = {
  target: string
  rememberPatterns: string[]
  label: string
  repeatSafe: boolean
}

const exactBashApprovalPrefix = "bash:exact:"
const autoApprovedFileReadBytes = 256 * 1024
const curlScopePrefix = "curl:"

export function bashApprovalForCommand(command: string, cwd = process.cwd()): BashApproval {
  const trimmed = command.trim()
  if (!trimmed) return exactBashApproval(trimmed)
  if (isDangerousCommand(trimmed)) return rawBashApproval(trimmed, false)
  const words = shellWords(trimmed)
  if (!words || words.length === 0) return exactBashApproval(trimmed)
  const [program = "", ...args] = words
  const normalizedProgram = path.basename(program)
  if (normalizedProgram === "git") return gitBashApproval(trimmed, args)
  if (normalizedProgram === "pwd") return scopedBashApproval("pwd", "project", [])
  if (normalizedProgram === "curl") {
    const curlScope = curlReadonlyScope(args)
    return curlScope ? scopedBashApproval(`${curlScopePrefix}${curlScope.kind}`, curlScope.scope, []) : exactBashApproval(trimmed)
  }
  if (normalizedProgram === "cat") {
    const fileScope = readonlySingleFileScope(normalizedProgram, args, cwd)
    return fileScope ? scopedBashApproval(normalizedProgram, fileScope, pathRememberPatterns(normalizedProgram, fileScope)) : exactBashApproval(trimmed)
  }
  if (normalizedProgram === "sed") {
    const fileScope = readonlySedScope(args, cwd)
    return fileScope ? scopedBashApproval("sed", fileScope, pathRememberPatterns("sed", fileScope)) : exactBashApproval(trimmed)
  }
  if (normalizedProgram === "rg" || normalizedProgram === "grep") {
    const searchScope = readonlySearchScope(normalizedProgram, args, cwd)
    return searchScope ? scopedBashApproval(normalizedProgram, searchScope.scope, searchScope.rememberPatterns) : exactBashApproval(trimmed)
  }
  if (!["ls", "wc", "find"].includes(normalizedProgram)) return exactBashApproval(trimmed)
  const pathArgs = args.filter((arg) => !arg.startsWith("-"))
  if (pathArgs.length > 1) return exactBashApproval(trimmed)
  const rawPath = pathArgs[0] ?? "."
  const resolved = path.resolve(cwd, rawPath)
  return scopedBashApproval(normalizedProgram, normalizedPath(resolved), pathRememberPatterns(normalizedProgram, resolved))
}

function gitBashApproval(command: string, args: string[]) {
  const subcommand = args.find((arg) => !arg.startsWith("-"))
  if (!subcommand || !["status", "diff", "log"].includes(subcommand)) return exactBashApproval(command)
  return scopedBashApproval(`git:${subcommand}`, "project", [])
}

function exactBashApproval(command: string): BashApproval {
  return {
    target: `${exactBashApprovalPrefix}${command}`,
    rememberPatterns: [`${exactBashApprovalPrefix}${command}`],
    label: "exact command",
    repeatSafe: true,
  }
}

function rawBashApproval(command: string, repeatSafe: boolean): BashApproval {
  return {
    target: command,
    rememberPatterns: [command],
    label: "raw command",
    repeatSafe,
  }
}

export function scopedBashApproval(kind: string, scope: string, rememberPatterns: string[], readonly: boolean = true): BashApproval {
  const prefix = readonly ? "bash:readonly:" : "bash:scoped:"
  const target = `${prefix}${kind}:${scope}`
  const labelScope = rememberPatterns.length > 0 ? rememberPatterns.map((pattern) => pattern.replace(`${prefix}${kind}:`, "")).join(", ") : scope
  return {
    target,
    rememberPatterns: rememberPatterns.length > 0 ? rememberPatterns : [target],
    label: readonly ? `readonly ${kind} ${labelScope}` : `${kind} ${labelScope}`,
    repeatSafe: true,
  }
}

function pathRememberPatterns(kind: string, resolved: string) {
  const normalized = normalizedPath(resolved)
  const parent = normalizedPath(path.dirname(resolved))
  const patterns = new Set([`bash:readonly:${kind}:${normalized}`])
  if (kind === "ls") patterns.add(`bash:readonly:${kind}:${parent}/*`)
  if (pathLooksDirectory(resolved)) patterns.add(`bash:readonly:${kind}:${normalized}/*`)
  return [...patterns]
}

function pathLooksDirectory(filePath: string) {
  try {
    return statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function pathLooksSmallFile(filePath: string) {
  try {
    const stat = statSync(filePath)
    return stat.isFile() && stat.size <= autoApprovedFileReadBytes
  } catch {
    return false
  }
}

function normalizedPath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
}

function shellWords(command: string) {
  if (/[;&><`$|]/.test(command)) return undefined
  const words: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (quote) return undefined
  if (current) words.push(current)
  return words
}

function readonlySingleFileScope(kind: string, args: string[], cwd: string) {
  const pathArgs = args.filter((arg) => !arg.startsWith("-"))
  if (pathArgs.length !== 1) return undefined
  const resolved = path.resolve(cwd, pathArgs[0] ?? ".")
  if (!pathLooksSmallFile(resolved)) return undefined
  return normalizedPath(resolved)
}

function readonlySedScope(args: string[], cwd: string) {
  if (!args.some((arg) => arg === "-n" || /^-[^-]*n/.test(arg))) return undefined
  const pathArgs = args.filter((arg) => !arg.startsWith("-"))
  if (pathArgs.length < 2) return undefined
  const resolved = path.resolve(cwd, pathArgs[pathArgs.length - 1] ?? ".")
  if (!pathLooksSmallFile(resolved)) return undefined
  return normalizedPath(resolved)
}

function readonlySearchScope(kind: "rg" | "grep", args: string[], cwd: string) {
  const pathArgs = searchPathArgs(kind, args)
  if (!pathArgs) return undefined
  if (pathArgs.length > 1) return undefined
  const resolved = path.resolve(cwd, pathArgs[0] ?? ".")
  if (!pathLooksDirectory(resolved) && !pathLooksSmallFile(resolved) && pathArgs.length > 0) return undefined
  return { scope: normalizedPath(resolved), rememberPatterns: pathRememberPatterns(kind, resolved) }
}

function searchPathArgs(kind: "rg" | "grep", args: string[]) {
  const nonOptionArgs = collectNonOptionArgs(args)
  if (nonOptionArgs.length === 0) return undefined
  return kind === "rg" ? nonOptionArgs.slice(1) : nonOptionArgs.slice(1)
}

function collectNonOptionArgs(args: string[]) {
  const values: string[] = []
  const consumeNext = new Set(["-e", "-f", "-g", "-m", "-A", "-B", "-C", "--regexp", "--file", "--glob", "--max-count", "--after-context", "--before-context", "--context"])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (!arg.startsWith("-") || arg === "-") {
      values.push(arg)
      continue
    }
    if (arg === "--") {
      return [...values, ...args.slice(index + 1)]
    }
    if (consumeNext.has(arg)) index += 1
  }
  return values
}

function curlReadonlyScope(args: string[]) {
  let method: "get" | "head" = "get"
  const urls: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (!arg.startsWith("-") || arg === "-") {
      urls.push(arg)
      continue
    }
    if (arg === "--") {
      urls.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith("--")) {
      const longFlag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
      const inlineValue = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined
      if (["--location", "--silent", "--show-error", "--fail", "--compressed", "--include", "--insecure", "--globoff", "--http1.1", "--http2", "--http2-prior-knowledge", "--ipv4", "--ipv6", "--path-as-is", "--no-progress-meter"].includes(longFlag)) continue
      if (longFlag === "--head") {
        method = "head"
        continue
      }
      if (longFlag === "--url") {
        const value = inlineValue ?? args[index + 1]
        if (!inlineValue) index += 1
        if (!value) return undefined
        urls.push(value)
        continue
      }
      if (longFlag === "--request") {
        const requestMethod = (inlineValue ?? args[index + 1] ?? "").toUpperCase()
        if (!inlineValue) index += 1
        if (requestMethod === "HEAD") method = "head"
        else if (requestMethod !== "GET") return undefined
        continue
      }
      if (["--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time"].includes(longFlag)) {
        if (!inlineValue) index += 1
        continue
      }
      if (longFlag === "--user-agent") {
        if (!inlineValue) index += 1
        continue
      }
      if (longFlag === "--header") {
        const value = inlineValue ?? args[index + 1]
        if (!inlineValue) index += 1
        if (!isSafeCurlHeader(value)) return undefined
        continue
      }
      return undefined
    }
    const shortFlags = arg.slice(1)
    if (shortFlags === "m" || shortFlags === "X" || shortFlags === "A" || shortFlags === "H") {
      const value = (args[index + 1] ?? "").toUpperCase()
      const rawValue = args[index + 1] ?? ""
      index += 1
      if (shortFlags === "X") {
        if (value === "HEAD") method = "head"
        else if (value !== "GET") return undefined
      }
      if (shortFlags === "H" && !isSafeCurlHeader(rawValue)) return undefined
      continue
    }
    if (shortFlags.startsWith("m")) continue
    if (shortFlags.startsWith("X")) {
      const value = shortFlags.slice(1).toUpperCase()
      if (value === "HEAD") method = "head"
      else if (value !== "GET") return undefined
      continue
    }
    if (shortFlags.startsWith("A")) continue
    if (shortFlags.startsWith("H")) {
      if (!isSafeCurlHeader(shortFlags.slice(1))) return undefined
      continue
    }
    if ([...shortFlags].every((flag) => ["L", "s", "S", "f", "I", "i", "k", "g", "4", "6"].includes(flag))) {
      if (shortFlags.includes("I")) method = "head"
      continue
    }
    return undefined
  }
  if (urls.length !== 1) return undefined
  try {
    const url = new URL(urls[0] ?? "")
    if (!["http:", "https:"].includes(url.protocol)) return undefined
    return { kind: method, scope: `${url.protocol}//${url.host}` }
  } catch {
    return undefined
  }
}

function isSafeCurlHeader(value: string | undefined) {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith("@")) return false
  const separator = trimmed.indexOf(":")
  if (separator <= 0) return false
  const name = trimmed.slice(0, separator).trim().toLowerCase()
  return [
    "accept",
    "accept-language",
    "cache-control",
    "if-modified-since",
    "if-none-match",
    "referer",
    "range",
    "user-agent",
  ].includes(name)
}


export function bashCwd(ctx: ToolContext, cwd: string | undefined) {
  try {
    return ctx.sandbox.resolve(cwd ?? ".")
  } catch {
    return ctx.sandbox.root
  }
}


export async function executeBashWithSandboxRecovery(params: z.infer<typeof BashInput>, ctx: ToolContext) {
  const options: SandboxExecuteOptions = {}
  let result: BashResult
  try {
    result = await ctx.sandbox.execute(params, ctx.agentMode, { ...options, signal: ctx.signal })
  } catch (error) {
    if (!(error instanceof SandboxPathEscapeError)) throw error
    const approved = await requestSandboxBypass(ctx, params, {
      reason: "path_boundary_escape",
      risk: "Reruns this command without EasyCode's explicit project-root path boundary check. The command may read from or reference paths outside the project root.",
      failure: error.message,
      reference: error.reference,
      resolved: error.resolved,
    })
    if (!approved) throw error
    options.bypassPathBoundary = true
    result = await ctx.sandbox.execute(params, ctx.agentMode, { ...options, signal: ctx.signal })
  }
  if (!looksLikeNativeSandboxDenial(result)) return result

  const approved = await requestSandboxBypass(ctx, params, {
    reason: "native_write_sandbox_denial",
    risk: "Reruns this command without the macOS write sandbox. The command may write outside the project root, including temp, cache, or home directories.",
    failure: sandboxFailureSummary(result),
  })
  if (!approved) {
    return { ...result, stderr: appendLine(result.stderr, "Sandbox bypass was not approved; command was not retried.") }
  }

  const retried = await ctx.sandbox.execute(params, ctx.agentMode, { ...options, bypassNativeWriteSandbox: true, signal: ctx.signal })
  return { ...retried, stderr: retried.stderr, sandboxBypassed: true }
}

async function requestSandboxBypass(ctx: ToolContext, params: z.infer<typeof BashInput>, metadata: Record<string, unknown>) {
  const reason = typeof metadata.reason === "string" ? metadata.reason : "sandbox_bypass"
  const approval = sandboxBypassApproval(reason, params.command, bashCwd(ctx, params.cwd))
  try {
    await ctx.permission.authorize({
      permission: "sandbox_bypass",
      patterns: [approval.target],
      always: approval.rememberPatterns,
      metadata: {
        tool: "bash",
        command: params.command,
        cwd: params.cwd,
        approvalScope: approval.label,
        rememberOnApprove: true,
        rememberPatterns: approval.rememberPatterns,
        ...metadata,
      },
    })
    return true
  } catch {
    return false
  }
}

function sandboxBypassApproval(reason: string, command: string, cwd: string): BashApproval {
  if (reason === "path_boundary_escape") {
    const approval = bashApprovalForCommand(command, cwd)
    return {
      target: `${reason}:${approval.target}`,
      rememberPatterns: approval.rememberPatterns.map((pattern) => `${reason}:${pattern}`),
      label: `${reason} ${approval.label}`,
      repeatSafe: approval.repeatSafe,
    }
  }
  const exact = exactBashApproval(command)
  return {
    target: `${reason}:${exact.target}`,
    rememberPatterns: exact.rememberPatterns.map((pattern) => `${reason}:${pattern}`),
    label: `${reason} ${exact.label}`,
    repeatSafe: true,
  }
}

export function bashResultToToolResult(command: string, result: BashResult): ToolResult {
  const { stdout, stderr, ...metadata } = result
  const output = [stdout, stderr, result.cancelled && !stdout && !stderr ? "Command cancelled by user." : ""].filter(Boolean).join("\n")
  return { title: command, output, metadata: { status: result.exitCode === 0 ? "succeeded" : "failed", ...metadata } }
}


function sandboxFailureSummary(result: BashResult) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 1_000)
}


function appendLine(text: string, line: string) {
  return text ? `${text}\n${line}` : line
}
