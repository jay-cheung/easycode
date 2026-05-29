import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"

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

  const hash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 12)
  return path.join(os.homedir(), ".easycode", "projects", hash)
}
