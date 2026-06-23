import type { DesktopFileSelection } from "../shared/protocol.js"

export type DesktopAttachment = {
  id: string
  kind: "file" | "image"
  name: string
  path: string
  size: string
}

export function formatAttachmentBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function isImageFile(filePath: string) {
  return /\.(png|jpe?g|gif|webp)$/i.test(filePath)
}

export function planPickedFiles(files: DesktopFileSelection[]) {
  return {
    images: files.filter((file) => isImageFile(file.path)),
    workspaceFiles: files.filter((file) => !isImageFile(file.path) && file.insideWorkspace),
    rejectedFiles: files.filter((file) => !isImageFile(file.path) && !file.insideWorkspace),
  }
}

export function pickedFileSlashCommands(files: DesktopFileSelection[]) {
  return {
    commands: files.flatMap((file) => {
      if (isImageFile(file.path)) return [imageSlashCommand(file.path)]
      if (file.insideWorkspace) return [fileSlashCommand(file.path)]
      return []
    }),
    rejectedCount: files.filter((file) => !isImageFile(file.path) && !file.insideWorkspace).length,
  }
}

export function clearAttachmentSlashCommands(files: DesktopAttachment[]) {
  const commands = []
  if (files.some((file) => file.kind === "image")) commands.push("/image clear")
  if (files.some((file) => file.kind === "file")) commands.push("/file clear")
  return commands
}

export function workspaceFileAttachment(file: DesktopFileSelection, id: string): DesktopAttachment {
  return {
    id,
    kind: "file",
    name: file.name,
    path: file.path,
    size: formatAttachmentBytes(file.size),
  }
}

export function fileAttachment(path: string, label: string, id: string, size = "workspace"): DesktopAttachment {
  return {
    id,
    kind: "file",
    name: slashFileName(path, label),
    path,
    size,
  }
}

export function imageAttachment(path: string, label: string, id: string): DesktopAttachment {
  return {
    id,
    kind: "image",
    name: slashImageName(path, label),
    path,
    size: "image",
  }
}

export type AttachmentAction =
  | { type: "addImage"; path: string; label: string }
  | { type: "clearImages" }
  | { type: "addFile"; path: string; label: string }
  | { type: "clearFiles" }

export function applyAttachmentAction(current: DesktopAttachment[], action: AttachmentAction | undefined, id: string): DesktopAttachment[] {
  if (!action) return current
  if (action.type === "addImage") return [...current, imageAttachment(action.path, action.label, id)]
  if (action.type === "clearImages") return current.filter((file) => file.kind !== "image")
  if (action.type === "addFile") return [...current, fileAttachment(action.path, action.label, id)]
  return current.filter((file) => file.kind !== "file")
}

export function rejectedWorkspaceFileSummary(count: number) {
  return `Skipped ${count} file${count === 1 ? "" : "s"} outside the workspace. Add workspace files or attach external content as images.`
}

export function imageSlashCommand(path: string) {
  return `/image ${path}`
}

export function fileSlashCommand(path: string) {
  return `/file ${path}`
}

export function slashImageName(imagePath: string, label: string) {
  const pathName = imagePath.split(/[\\/]/).filter(Boolean).at(-1)
  return pathName || label || "image"
}

export function slashFileName(filePath: string, label: string) {
  return label || filePath.split(/[\\/]/).filter(Boolean).at(-1) || "file"
}

export function removeFileRefs(text: string, filePaths: string[]) {
  if (filePaths.length === 0) return text
  const refs = new Set(filePaths.map((filePath) => `@${filePath}`))
  return text.split("\n").filter((line) => !refs.has(line.trim())).join("\n").trimStart()
}
