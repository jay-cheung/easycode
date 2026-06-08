import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"

export function easycodeProjectHash(root: string) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)
}

export function easycodeGlobalProjectDir(root: string) {
  const resolvedRoot = path.resolve(root)
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return path.join(resolvedRoot, ".easycode")
  }
  return path.join(os.homedir(), ".easycode", "projects", easycodeProjectHash(root))
}

export function homeRelativePath(targetPath: string) {
  const absolute = path.resolve(targetPath)
  const home = os.homedir()
  if (absolute === home) return "~"
  if (absolute.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absolute).replaceAll(path.sep, "/")}`
  }
  return absolute.replaceAll(path.sep, "/")
}

/**
 * Resolve the easycode data directory for a project.
 *
 * Priority:
 * 1. If `EASYCODE_DEBUG` env is set → use `root/.easycode/`
 * 2. If `root/.easycode/` already exists → use it (backward compat)
 * 3. Otherwise → `~/.easycode/projects/<hash-of-root-path>/`
 */
export function easycodeDir(root: string): string {
  const resolvedRoot = path.resolve(root)

  if (
    process.env.EASYCODE_DEBUG ||
    process.env.EASYCODE_LOGGER === "true" ||
    process.argv.includes("--logger") ||
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test"
  ) {
    return path.join(resolvedRoot, ".easycode")
  }

  const localDir = path.join(resolvedRoot, ".easycode")
  if (existsSync(localDir)) {
    return localDir
  }

  return easycodeGlobalProjectDir(resolvedRoot)
}
