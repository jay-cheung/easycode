import { app } from "electron"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import type { DesktopSettings } from "../shared/protocol.js"

const settingsFile = () => path.join(app.getPath("userData"), "settings.json")

export async function loadSettings(): Promise<DesktopSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), "utf8")) as Partial<DesktopSettings>
    return normalizeSettings(parsed)
  } catch {
    return normalizeSettings({})
  }
}

export async function saveSettings(input: Partial<DesktopSettings>) {
  const next = normalizeSettings(input)
  await mkdir(path.dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(next, null, 2))
  return next
}

export function normalizeSettings(input: Partial<DesktopSettings>): DesktopSettings {
  const workspaceRoot = input.workspaceRoot || process.cwd()
  return {
    workspaceRoot,
    sidecarPath: input.sidecarPath || undefined,
    provider: input.provider || "fake",
    session: input.session || "default",
    recentWorkspaces: unique([workspaceRoot, ...(input.recentWorkspaces ?? [])]).slice(0, 8),
  }
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}
