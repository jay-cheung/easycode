import path from "node:path"
import { stat } from "node:fs/promises"

export type AttachedFileRef = {
  input: string
  path: string
  relativePath: string
  size: number
}

export async function attachedFileFromInput(root: string, fileInput: string): Promise<AttachedFileRef> {
  const resolvedRoot = path.resolve(root)
  const resolved = path.isAbsolute(fileInput) ? path.resolve(fileInput) : path.resolve(resolvedRoot, fileInput)
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Attached file must be inside the workspace: ${fileInput}`)
  }
  const info = await stat(resolved).catch((error) => {
    throw new Error(`Attached file is not readable: ${fileInput} (${error instanceof Error ? error.message : String(error)})`)
  })
  if (!info.isFile()) throw new Error(`Attached path is not a file: ${fileInput}`)
  return {
    input: fileInput,
    path: resolved,
    relativePath: relative.split(path.sep).join("/"),
    size: info.size,
  }
}

export function attachedFileLine(file: AttachedFileRef) {
  return `- ${file.relativePath} (${file.size} bytes)`
}

export async function promptWithAttachedFiles(root: string, text: string, fileInputs: string[]) {
  if (fileInputs.length === 0) return text
  const attachments = await Promise.all(fileInputs.map((fileInput) => attachedFileFromInput(root, fileInput)))
  return [
    text,
    "",
    "<attached_files>",
    "The user attached these workspace files. Inspect the relevant files with read_lines/read before answering or editing.",
    ...attachments.map(attachedFileLine),
    "</attached_files>",
  ].join("\n")
}
