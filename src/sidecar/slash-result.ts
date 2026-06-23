import type { SidecarSlashCommandResult } from "./types"

export function slashResultShouldPersist(result: SidecarSlashCommandResult) {
  return result.handled === true && Boolean(result.settings)
}
