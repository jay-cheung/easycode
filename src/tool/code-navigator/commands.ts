import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import type { CommandResult } from "./types"

const require = createRequire(import.meta.url)

let cachedRgPath: string | null = null
export function getRgPath(): string {
  if (process.env.NODE_ENV === "test") return "rg"
  if (cachedRgPath) return cachedRgPath
  try {
    const proc = Bun.spawnSync(["which", "rg"])
    if (proc.success) {
      const p = proc.stdout.toString().trim()
      if (p && existsSync(p)) {
        cachedRgPath = p
        return p
      }
    }
  } catch {}

  const macOSPaths = [
    "/Applications/Codex.app/Contents/Resources/rg",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
    "/Applications/Cursor.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg"
  ]
  for (const p of macOSPaths) {
    if (existsSync(p)) {
      cachedRgPath = p
      return p
    }
  }

  try {
    const vscodeRg = require("vscode-ripgrep")
    if (vscodeRg && vscodeRg.rgPath && existsSync(vscodeRg.rgPath)) {
      cachedRgPath = vscodeRg.rgPath
      return vscodeRg.rgPath
    }
  } catch {}

  cachedRgPath = "rg"
  return "rg"
}

export function defaultRunner(command: string, args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe", signal: options.signal })
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.catch(() => null),
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))
}

export function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ""
}
