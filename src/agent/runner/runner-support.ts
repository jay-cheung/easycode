import type { AgentMode } from "../../message"
import type { PermissionRule, PermissionService } from "../../permission"
import { defaultPermissionRules } from "../../permission"
import type { SessionSettings } from "../../settings"
import type { SkillServiceLike } from "../../skill"

export async function selectedSkillsForSettings(skills: SkillServiceLike, settings: SessionSettings) {
  const selected = settings.selectedSkills ?? []
  if (selected.length === 0) return []
  const available = await skills.available()
  const nameSet = new Set(selected)
  const idSet = new Set(selected)
  const matched = available.filter((skill) => idSet.has(skill.id) || nameSet.has(skill.name))
  return (await Promise.all(matched.map((skill) => skills.load(skill.id)))).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
}

export function pendingSelectedSkillsForSettings(
  settings: SessionSettings,
  selectedSkills: Awaited<ReturnType<typeof selectedSkillsForSettings>>,
) {
  const pending = new Set(settings.pendingSkillLoads ?? [])
  if (pending.size === 0) return []
  return selectedSkills.filter((skill) => pending.has(skill.id) || pending.has(skill.name))
}

export function markSkillLoadedInSettings(settings: SessionSettings, input: unknown) {
  if (!input || typeof input !== "object") return
  const name = (input as { name?: unknown }).name
  if (typeof name !== "string") return
  settings.pendingSkillLoads = (settings.pendingSkillLoads ?? []).filter((skill) => skill !== name)
}

export function effectiveModeForPrompt(_prompt: string, mode: AgentMode, _hasProposedPlan: boolean): AgentMode {
  return mode
}

export function permissionServiceForMode(permission: PermissionService, mode: AgentMode) {
  const rules = defaultPermissionRules(mode)
  if (samePermissionRules(permission.rules, rules)) return permission
  return permission.withRules(rules)
}

function samePermissionRules(left: PermissionRule[], right: PermissionRule[]) {
  if (left.length !== right.length) return false
  return left.every((rule, index) => {
    const other = right[index]
    return Boolean(other) && rule.permission === other.permission && rule.pattern === other.pattern && rule.action === other.action
  })
}
