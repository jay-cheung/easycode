import os from "node:os"
import path from "node:path"
import { realpath } from "node:fs/promises"

export type InstructionSource = "project" | "global"

export type InstructionInfo = {
  source: InstructionSource
  path: string
  content: string
}

export interface InstructionServiceLike {
  system(): Promise<InstructionInfo[]>
}

export type InstructionServiceOptions = {
  globalFiles?: string[]
}

const easycodeInstructionFiles = ["easycode.md", "EASYCODE.md"]
const projectInstructionFiles = [...easycodeInstructionFiles, "AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

function defaultGlobalFiles() {
  const home = os.homedir()
  return [
    path.join(home, ".easycode", "easycode.md"),
    path.join(home, ".easycode", "EASYCODE.md"),
    path.join(home, ".easycode", "AGENTS.md"),
    path.join(home, ".claude", "CLAUDE.md"),
  ]
}

export class InstructionService implements InstructionServiceLike {
  readonly root: string
  readonly globalFiles: string[]

  constructor(root: string, options: InstructionServiceOptions = {}) {
    this.root = root
    this.globalFiles = options.globalFiles ?? defaultGlobalFiles()
  }

  async system() {
    const files = await resolveExisting([
      ...projectInstructionFiles.map((file) => ({ source: "project" as const, filePath: path.join(this.root, file), displayPath: file })),
      ...this.globalFiles.map((filePath) => ({ source: "global" as const, filePath, displayPath: displayGlobalPath(filePath) })),
    ])
    const instructions: InstructionInfo[] = []
    for (const file of files) {
      const normalized = path.resolve(file.filePath)
      const content = await readInstruction(normalized)
      if (!content) continue
      instructions.push({ source: file.source, path: file.displayPath, content })
    }
    return instructions
  }
}

type InstructionFile = {
  source: InstructionSource
  filePath: string
  displayPath: string
}

async function resolveExisting(files: InstructionFile[]) {
  const seen = new Set<string>()
  const resolved: InstructionFile[] = []
  for (const file of files) {
    const normalized = path.resolve(file.filePath)
    const candidate = Bun.file(normalized)
    if (!(await candidate.exists())) continue
    const canonical = await canonicalInstructionPath(normalized)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    resolved.push(file)
  }
  return resolved
}

async function readInstruction(filePath: string) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return ""
  return (await file.text()).trim()
}

function displayGlobalPath(filePath: string) {
  const home = os.homedir()
  return filePath.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, filePath)}` : filePath
}

async function canonicalInstructionPath(filePath: string) {
  try {
    return await realpath(filePath)
  } catch {
    return filePath
  }
}
