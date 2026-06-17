import path from "node:path"
import { copyFile, mkdir, rename, unlink } from "node:fs/promises"

export type JsonLoadResult<T> = {
  data?: T
  source: "missing" | "primary" | "backup" | "invalid"
  error?: unknown
}

export async function loadJsonWithBackup<T>(filePath: string): Promise<JsonLoadResult<T>> {
  const primary = await readJsonFile<T>(filePath)
  if (primary.source === "primary" || primary.source === "missing") return primary

  const backup = await readJsonFile<T>(backupPath(filePath))
  if (backup.source === "primary") {
    await copyFile(backupPath(filePath), filePath).catch(() => undefined)
    return { data: backup.data, source: "backup", error: primary.error }
  }
  if (backup.source === "missing") return { source: "invalid", error: primary.error }
  return { source: "invalid", error: backup.error ?? primary.error }
}

export async function writeJsonAtomically(filePath: string, data: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`
  await Bun.write(tmpPath, `${JSON.stringify(data, null, 2)}\n`)
  if ((await readJsonFile<unknown>(filePath)).source === "primary") {
    await copyFile(filePath, backupPath(filePath)).catch(() => undefined)
  }
  try {
    await rename(tmpPath, filePath)
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

export function backupPath(filePath: string) {
  return `${filePath}.bak`
}

async function readJsonFile<T>(filePath: string): Promise<JsonLoadResult<T>> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return { source: "missing" }
  try {
    return { data: JSON.parse(await file.text()) as T, source: "primary" }
  } catch (error) {
    return { source: "invalid", error }
  }
}
