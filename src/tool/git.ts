import path from "node:path"
import { z } from "zod"
import { clampInt } from "../utils/math"
import type { ToolContext, ToolResult } from "./registry"

const OptionalString = z.string().nullish().transform((value) => value ?? undefined)
const OptionalNumber = z.number().nullish().transform((value) => value ?? undefined)
export const GitDiffInput = z.object({ mode: z.enum(["summary", "files", "stat", "file"]).nullish().transform((value) => value ?? "summary"), filePath: OptionalString, maxBytes: OptionalNumber })

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

function gitDiffArgs(params: { mode: z.infer<typeof GitDiffInput>["mode"]; filePath?: string }) {
  if (params.mode === "files") return ["diff", "--name-only"]
  if (params.mode === "stat") return ["diff", "--stat"]
  if (params.mode === "file") return ["diff", "--", params.filePath ?? ""]
  return ["diff", "--name-status", "--stat"]
}

async function runGit(args: string[], cwd: string, signal: AbortSignal | undefined) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", signal })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.catch(() => null),
  ])
  return { stdout, stderr, exitCode }
}

function truncateText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const buffer = Buffer.from(text)
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated ${buffer.length - maxBytes} bytes; use git_diff mode=file with a narrower file or inspect another file separately]`
}


function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ""
}

