import path from "node:path"
import { z } from "zod"
import { clampInt } from "../utils/math"
import type { ToolContext, ToolResult } from "./registry"

const OptionalString = z.string().nullish().transform((value) => value ?? undefined)
const OptionalNumber = z.number().nullish().transform((value) => value ?? undefined)
export const GitDiffInput = z.object({ mode: z.enum(["summary", "files", "stat", "file"]).nullish().transform((value) => value ?? "summary"), filePath: OptionalString, maxBytes: OptionalNumber })
export const GitStatusInput = z.object({ short: z.boolean().nullish().transform((value) => value ?? true) })
export const GitStageInput = z.object({ files: z.array(z.string()).min(1).max(50) })
export const GitCommitInput = z.object({ message: z.string().min(1), files: z.array(z.string()).min(1).max(50) })
export const GitBranchInput = z.object({ name: OptionalString, create: z.boolean().nullish().transform((value) => value ?? false), startPoint: OptionalString })
export const GitLogInput = z.object({ limit: z.number().nullish().transform((value) => value ?? 10) })
export const GitRestoreInput = z.object({ files: z.array(z.string()).min(1).max(50), staged: z.boolean().nullish().transform((value) => value ?? false), worktree: z.boolean().nullish().transform((value) => value ?? true) })

export async function gitDiffToolResult(params: z.infer<typeof GitDiffInput>, ctx: ToolContext): Promise<ToolResult> {
  if (params.mode === "file" && !params.filePath) throw new Error("git_diff mode=file requires filePath")
  const maxBytes = clampInt(params.maxBytes ?? 12_000, 1_000, 30_000)
  const filePath = params.mode === "file" && params.filePath ? path.relative(ctx.sandbox.root, ctx.sandbox.resolve(params.filePath)).replaceAll(path.sep, "/") || "." : undefined
  const args = gitDiffArgs({ mode: params.mode, filePath })
  const result = await runGit(args, ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git diff failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`}`)
  const output = params.mode === "file" ? truncateText(result.stdout || "(no diff)", maxBytes) : result.stdout || "(no changes)"
  return {
    title: params.mode === "file" ? `git diff -- ${filePath}` : `git diff ${params.mode}`,
    output,
    metadata: {
      status: "succeeded",
      mode: params.mode,
      filePath,
      truncated: result.stdout.length > output.length,
    },
  }
}

export async function gitStatusToolResult(params: z.infer<typeof GitStatusInput>, ctx: ToolContext): Promise<ToolResult> {
  const args = params.short ? ["status", "--short", "--branch"] : ["status"]
  const result = await runGit(args, ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git status failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  return { title: "git status", output: result.stdout || "(clean)", metadata: { status: "succeeded" } }
}

export async function gitStageToolResult(params: z.infer<typeof GitStageInput>, ctx: ToolContext): Promise<ToolResult> {
  const files = normalizeGitFiles(params.files, ctx)
  const result = await runGit(["add", "--", ...files], ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git stage failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  const staged = await stagedFiles(ctx)
  return { title: "git stage", output: staged.length ? staged.join("\n") : "(nothing staged)", metadata: { status: "succeeded", files, staged } }
}

export async function gitCommitToolResult(params: z.infer<typeof GitCommitInput>, ctx: ToolContext): Promise<ToolResult> {
  const files = normalizeGitFiles(params.files, ctx)
  const preStaged = await stagedFiles(ctx)
  const unrelated = preStaged.filter((file) => !files.includes(file))
  if (unrelated.length > 0) throw new Error(`Refusing to commit unrelated staged files: ${unrelated.join(", ")}`)
  const stage = await runGit(["add", "--", ...files], ctx.sandbox.root, ctx.signal)
  if (stage.exitCode !== 0) throw new Error(`git stage failed: ${firstLine(stage.stderr) || `exit ${stage.exitCode}`}`)
  const staged = await stagedFiles(ctx)
  const outside = staged.filter((file) => !files.includes(file))
  if (outside.length > 0) throw new Error(`Refusing to commit staged files outside explicit list: ${outside.join(", ")}`)
  if (staged.length === 0) throw new Error("Refusing to commit because no explicit files are staged")
  const commit = await runGit(["commit", "-m", params.message], ctx.sandbox.root, ctx.signal)
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${firstLine(commit.stderr) || firstLine(commit.stdout) || `exit ${commit.exitCode}`}`)
  return { title: "git commit", output: commit.stdout || commit.stderr, metadata: { status: "succeeded", files: staged } }
}

export async function gitBranchToolResult(params: z.infer<typeof GitBranchInput>, ctx: ToolContext): Promise<ToolResult> {
  if (params.create && ctx.agentMode === "plan") throw new Error("git_branch create is not available in plan mode")
  const args = params.create
    ? ["switch", "-c", requiredBranchName(params.name), ...(params.startPoint ? [params.startPoint] : [])]
    : ["branch", "--show-current"]
  const result = await runGit(args, ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git branch failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`}`)
  return { title: params.create ? `git branch ${params.name}` : "git branch current", output: result.stdout || result.stderr, metadata: { status: "succeeded", branch: params.name } }
}

export async function gitLogToolResult(params: z.infer<typeof GitLogInput>, ctx: ToolContext): Promise<ToolResult> {
  const limit = clampInt(params.limit, 1, 50)
  const result = await runGit(["log", "--oneline", `-${limit}`], ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git log failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  return { title: "git log", output: result.stdout || "(no commits)", metadata: { status: "succeeded", limit } }
}

export async function gitRestoreToolResult(params: z.infer<typeof GitRestoreInput>, ctx: ToolContext): Promise<ToolResult> {
  const files = normalizeGitFiles(params.files, ctx)
  const modeArgs = params.staged && params.worktree ? ["--staged", "--worktree"] : params.staged ? ["--staged"] : ["--worktree"]
  const result = await runGit(["restore", ...modeArgs, "--", ...files], ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git restore failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  return { title: "git restore guarded", output: files.join("\n"), metadata: { status: "succeeded", files, staged: params.staged, worktree: params.worktree } }
}

function gitDiffArgs(params: { mode: z.infer<typeof GitDiffInput>["mode"]; filePath?: string }) {
  if (params.mode === "files") return ["diff", "--name-only"]
  if (params.mode === "stat") return ["diff", "--stat"]
  if (params.mode === "file") return ["diff", "--", params.filePath ?? ""]
  return ["diff", "--name-status", "--stat"]
}

export async function runGit(args: string[], cwd: string, signal: AbortSignal | undefined) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", signal })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.catch(() => null),
  ])
  return { stdout, stderr, exitCode }
}

function normalizeGitFiles(files: string[], ctx: ToolContext) {
  return files.map((file) => path.relative(ctx.sandbox.root, ctx.sandbox.resolve(file)).replaceAll(path.sep, "/") || ".")
}

async function stagedFiles(ctx: ToolContext) {
  const result = await runGit(["diff", "--name-only", "--cached"], ctx.sandbox.root, ctx.signal)
  if (result.exitCode !== 0) throw new Error(`git diff --cached failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function requiredBranchName(name: string | undefined) {
  if (!name) throw new Error("git_branch create requires name")
  if (name.startsWith("-") || name.includes("..") || name.includes(" ")) throw new Error(`Invalid branch name: ${name}`)
  return name
}

function truncateText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const buffer = Buffer.from(text)
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated ${buffer.length - maxBytes} bytes; use git_diff mode=file with a narrower file or inspect another file separately]`
}


function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ""
}
