import type { UiCopy } from "./types"

export function cloneWith(base: UiCopy, overrides: Partial<UiCopy>): UiCopy {
  return { ...base, ...overrides }
}
