import path from "node:path"
import { defaultProviderName, normalizeSessionSettings, type SessionSettings } from "../settings"
import { assertProtocolVersion, SidecarProtocolError } from "./jsonl"
import type { InitializeParams, ReplyPermissionParams, ReplyPlanParams, RunPromptParams } from "./types"

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

export function parseRunPromptParams(params: unknown): RunPromptParams {
  const input = record(params)
  if (typeof input.text !== "string" || !input.text.trim()) throw new SidecarProtocolError("invalid_params", "runPrompt requires non-empty text.")
  const mode = input.mode === "plan" ? "plan" : "build"
  return {
    text: input.text,
    mode,
    ...(typeof input.session === "string" && input.session.trim() ? { session: input.session.trim() } : {}),
  }
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
  return {
    runId: input.runId,
    action: input.action,
    ...(typeof input.text === "string" ? { text: input.text } : {}),
  }
}

export function record(value: unknown): Record<string, any> {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SidecarProtocolError("invalid_params", "Params must be a JSON object.")
  return value as Record<string, any>
}
