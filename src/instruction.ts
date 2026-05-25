import os from "node:os"
import path from "node:path"

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

const projectInstructionFiles = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

function defaultGlobalFiles() {
  const home = os.homedir()
  return [
    path.join(home, ".easycode", "AGENTS.md"),
    path.join(home, ".agent", "AGENTS.md"),
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
    const files = [
      ...projectInstructionFiles.map((file) => ({ source: "project" as const, filePath: path.join(this.root, file), displayPath: file })),
      ...this.globalFiles.map((filePath) => ({ source: "global" as const, filePath, displayPath: displayGlobalPath(filePath) })),
    ]
    const seen = new Set<string>()
    const instructions: InstructionInfo[] = []
    for (const file of files) {
      const normalized = path.resolve(file.filePath)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      const content = await readInstruction(normalized)
      if (!content) continue
      instructions.push({ source: file.source, path: file.displayPath, content })
    }
    return instructions
  }
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
