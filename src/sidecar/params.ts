import path from "node:path"
import { defaultProviderName, normalizeSessionSettings, type SessionSettings } from "../settings"
import { assertProtocolVersion, SidecarProtocolError } from "./jsonl"
import type { ExecuteSlashCommandParams, InitializeParams, ReplyPermissionParams, ReplyPlanParams, RunPromptParams, UpdateSettingsParams } from "./types"

export function parseInitializeParams(params: unknown, fallbackRoot: string, fallbackSettings: SessionSettings): InitializeParams & { root: string; session: string; settings: SessionSettings } {
  const input = record(params)
  assertProtocolVersion(input.protocolVersion)
  const root = typeof input.root === "string" && input.root ? path.resolve(input.root) : fallbackRoot
  const provider = typeof input.provider === "string" && input.provider ? input.provider : fallbackSettings.provider || defaultProviderName
  const settings = normalizeSessionSettings({
    ...fallbackSettings,
    ...input,
    provider,
  }, provider)
  const session = typeof input.session === "string" && input.session.trim() ? input.session.trim() : "default"
  return { ...input, root, session, settings }
}

export function parseSessionParam(params: unknown, fallback: string) {
  const input = record(params)
  return typeof input.session === "string" && input.session.trim() ? input.session.trim() : fallback
}

export function parseGoalControlParams(params: unknown, fallbackSession: string) {
  const input = record(params)
  return {
    session: typeof input.session === "string" && input.session.trim() ? input.session.trim() : fallbackSession,
    ...(typeof input.reason === "string" && input.reason.trim() ? { reason: input.reason.trim() } : {}),
  }
}

export function parseRunPromptParams(params: unknown): RunPromptParams {
  const input = record(params)
  if (typeof input.text !== "string" || !input.text.trim()) throw new SidecarProtocolError("invalid_params", "runPrompt requires non-empty text.")
  const mode = input.mode === "plan" || input.mode === "goal" ? input.mode : "build"
  return {
    text: input.text,
    mode,
    permissionMode: input.permissionMode === "auto-review" ? "auto-review" : "ask",
    images: stringList(input.images, "images"),
    files: stringList(input.files, "files"),
    ...(typeof input.session === "string" && input.session.trim() ? { session: input.session.trim() } : {}),
  }
}

export function parseExecuteSlashCommandParams(params: unknown): ExecuteSlashCommandParams {
  const input = record(params)
  if (typeof input.text !== "string" || !input.text.trim()) throw new SidecarProtocolError("invalid_params", "executeSlashCommand requires non-empty text.")
  if (input.pendingImages !== undefined && (!Number.isInteger(input.pendingImages) || input.pendingImages < 0)) {
    throw new SidecarProtocolError("invalid_params", "pendingImages must be a non-negative integer.")
  }
  if (input.pendingFiles !== undefined && (!Number.isInteger(input.pendingFiles) || input.pendingFiles < 0)) {
    throw new SidecarProtocolError("invalid_params", "pendingFiles must be a non-negative integer.")
  }
  return {
    text: input.text,
    ...(input.pendingImages !== undefined ? { pendingImages: input.pendingImages } : {}),
    ...(input.pendingFiles !== undefined ? { pendingFiles: input.pendingFiles } : {}),
  }
}

export function parseUpdateSettingsParams(params: unknown): UpdateSettingsParams {
  const input = record(params)
  const output: UpdateSettingsParams = {}
  if (input.session !== undefined) output.session = nonEmptyString(input.session, "session")
  if (input.provider !== undefined) output.provider = nonEmptyString(input.provider, "provider")
  if (input.model !== undefined) output.model = nullableNonEmptyString(input.model, "model")
  if (input.language !== undefined) output.language = nonEmptyString(input.language, "language") as UpdateSettingsParams["language"]
  if (input.thinking !== undefined) output.thinking = booleanValue(input.thinking, "thinking")
  if (input.effort !== undefined) output.effort = nonEmptyString(input.effort, "effort") as UpdateSettingsParams["effort"]
  if (input.maxTokens !== undefined) output.maxTokens = nullablePositiveInteger(input.maxTokens, "maxTokens")
  if (input.maxSteps !== undefined) output.maxSteps = nullablePositiveInteger(input.maxSteps, "maxSteps")
  if (input.selectedSkills !== undefined) output.selectedSkills = stringList(input.selectedSkills, "selectedSkills") ?? []
  if (input.pendingSkillLoads !== undefined) output.pendingSkillLoads = stringList(input.pendingSkillLoads, "pendingSkillLoads") ?? []
  return output
}

export function parseReplyPermissionParams(params: unknown): ReplyPermissionParams {
  const input = record(params)
  if (typeof input.requestId !== "string" || !input.requestId) throw new SidecarProtocolError("invalid_params", "replyPermission requires requestId.")
  if (input.reply !== "once" && input.reply !== "always" && input.reply !== "reject") throw new SidecarProtocolError("invalid_params", "replyPermission reply must be once, always, or reject.")
  return { requestId: input.requestId, reply: input.reply }
}

export function parseReplyPlanParams(params: unknown): ReplyPlanParams {
  const input = record(params)
  if (typeof input.runId !== "string" || !input.runId) throw new SidecarProtocolError("invalid_params", "replyPlan requires runId.")
  if (input.action !== "approve" && input.action !== "reject" && input.action !== "edit" && input.action !== "new_prompt") {
    throw new SidecarProtocolError("invalid_params", "replyPlan action is not supported.")
  }
  if ((input.action === "edit" || input.action === "new_prompt") && (typeof input.text !== "string" || !input.text.trim())) {
    throw new SidecarProtocolError("invalid_params", "replyPlan edit and new_prompt require non-empty text.")
  }
  return {
    runId: input.runId,
    action: input.action,
    ...(typeof input.text === "string" ? { text: input.text.trim() } : {}),
  }
}

export function record(value: unknown): Record<string, any> {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SidecarProtocolError("invalid_params", "Params must be a JSON object.")
  return value as Record<string, any>
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new SidecarProtocolError("invalid_params", `${name} must be an array of strings.`)
  return value
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SidecarProtocolError("invalid_params", `${name} must be a non-empty string.`)
  return value.trim()
}

function nullableNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === null) return undefined
  return nonEmptyString(value, name)
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new SidecarProtocolError("invalid_params", `${name} must be a boolean.`)
  return value
}

function nullablePositiveInteger(value: unknown, name: string): number | undefined {
  if (value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new SidecarProtocolError("invalid_params", `${name} must be a positive integer or null.`)
  return value
}
