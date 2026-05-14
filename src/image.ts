import path from "node:path"
import { readFileSync } from "node:fs"
import { imagePart, type ImagePart, type ImageSource } from "./message"

const mimeByExtension = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
])

export function isImageURL(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function mimeTypeForImagePath(filePath: string) {
  return mimeByExtension.get(path.extname(filePath).toLowerCase())
}

export async function imagePartFromInput(input: string, root: string): Promise<ImagePart> {
  const value = input.trim()
  if (!value) throw new Error("/image requires a local path or http(s) URL")
  if (isImageURL(value)) return imagePart({ type: "url", url: value })
  const resolved = path.resolve(root, value)
  const mimeType = mimeTypeForImagePath(resolved)
  if (!mimeType) throw new Error(`Unsupported image type: ${path.extname(resolved) || "(none)"}`)
  const file = Bun.file(resolved)
  if (!(await file.exists())) throw new Error(`Image not found: ${resolved}`)
  return imagePart({ type: "path", path: resolved, mimeType })
}

export function imageLabel(source: ImageSource) {
  return source.type === "url" ? source.url : source.path
}

export function imageSourceToDataURL(source: ImageSource) {
  if (source.type === "url") return source.url
  const bytes = readFileSync(source.path)
  return `data:${source.mimeType};base64,${Buffer.from(bytes).toString("base64")}`
}

