import { sidecarProtocolVersion, type SidecarEventEnvelope, type SidecarMethod, type SidecarRequest, type SidecarResponse } from "./types"

const methods: Set<SidecarMethod> = new Set([
  "initialize",
  "listProviders",
  "getProviderReadiness",
  "listSkills",
  "listSessions",
  "loadSession",
  "deleteSession",
  "getGoalStatus",
  "pauseGoal",
  "resumeGoal",
  "clearGoal",
  "getPlanStatus",
  "clearPlan",
  "getSettings",
  "updateSettings",
  "executeSlashCommand",
  "runPrompt",
  "cancelRun",
  "replyPermission",
  "replyPlan",
  "shutdown",
])

export class SidecarProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "SidecarProtocolError"
  }
}

export function parseSidecarRequestLine(line: string): SidecarRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new SidecarProtocolError("invalid_json", "Request line must be valid JSON.")
  }
  if (!isRecord(parsed)) throw new SidecarProtocolError("invalid_request", "Request must be a JSON object.")
  if (typeof parsed.id !== "string" || !parsed.id) throw new SidecarProtocolError("invalid_id", "Request id must be a non-empty string.")
  if (typeof parsed.method !== "string" || !methods.has(parsed.method as SidecarMethod)) {
    throw new SidecarProtocolError("invalid_method", "Request method is not supported.")
  }
  return { id: parsed.id, method: parsed.method as SidecarMethod, params: parsed.params }
}

export function assertProtocolVersion(value: unknown) {
  if (value !== undefined && value !== sidecarProtocolVersion) {
    throw new SidecarProtocolError("protocol_version_mismatch", `Expected sidecar protocol version ${sidecarProtocolVersion}.`)
  }
}

export function encodeSidecarResponse(response: SidecarResponse) {
  return `${JSON.stringify(response)}\n`
}

export function encodeSidecarEvent(event: SidecarEventEnvelope) {
  return `${JSON.stringify(event)}\n`
}

export function sidecarErrorResponse(id: string, error: unknown): SidecarResponse {
  if (error instanceof SidecarProtocolError) {
    return { id, ok: false, error: { code: error.code, message: error.message } }
  }
  return { id, ok: false, error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
}
