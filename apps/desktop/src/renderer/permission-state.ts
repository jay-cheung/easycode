import type { DesktopPermissionMode, DesktopRunMode } from "../shared/protocol.js"

export type EffectivePermissionMode = DesktopPermissionMode | "goal-restricted"

export type PermissionRunSnapshot = {
  runMode: DesktopRunMode
  permissionMode: DesktopPermissionMode
  effectiveMode: EffectivePermissionMode
  sidecarMode: DesktopPermissionMode
}

export type PermissionRequestLike = {
  id: string
  permission: string
  patterns: string[]
}

export type PermissionReplyAction = "approve" | "reject"
export type SidecarPermissionReply = "once" | "reject"

export function effectivePermissionMode(runMode: DesktopRunMode, permissionMode: DesktopPermissionMode): EffectivePermissionMode {
  return runMode === "goal" ? "goal-restricted" : permissionMode
}

export function permissionModeLabel(mode: EffectivePermissionMode) {
  if (mode === "auto-review") return "Auto-review"
  if (mode === "goal-restricted") return "Goal restricted"
  return "Ask"
}

export function sidecarPermissionMode(runMode: DesktopRunMode, permissionMode: DesktopPermissionMode): DesktopPermissionMode {
  return runMode === "goal" ? "ask" : permissionMode
}

export function permissionRunSnapshot(runMode: DesktopRunMode, permissionMode: DesktopPermissionMode): PermissionRunSnapshot {
  return {
    runMode,
    permissionMode,
    effectiveMode: effectivePermissionMode(runMode, permissionMode),
    sidecarMode: sidecarPermissionMode(runMode, permissionMode),
  }
}

export function permissionPromptFromRequest(request: PermissionRequestLike) {
  return {
    requestId: request.id,
    title: `${request.permission}: ${request.patterns.join(", ")}`,
    detail: "EasyCode needs approval before continuing this local operation.",
  }
}

export function permissionRequiredSummary(request: PermissionRequestLike) {
  return `Permission required: ${request.permission}: ${request.patterns.join(", ")}`
}

export function shouldShowPermissionPrompt(mode: EffectivePermissionMode) {
  return mode === "ask"
}

export function permissionRequestPresentation(mode: EffectivePermissionMode, request: PermissionRequestLike) {
  if (shouldShowPermissionPrompt(mode)) {
    return {
      showPrompt: true,
      progressSummary: permissionRequiredSummary(request),
      prompt: permissionPromptFromRequest(request),
    } as const
  }
  return {
    showPrompt: false,
    autoReply: "reject",
    statusText: `Ignored unexpected manual permission request: ${permissionRequiredSummary(request)}`,
  } as const
}

export function permissionUiAfterRequest(mode: EffectivePermissionMode, request: PermissionRequestLike) {
  const presentation = permissionRequestPresentation(mode, request)
  if (presentation.showPrompt) {
    return {
      prompt: presentation.prompt,
      progressStatus: "waiting_permission" as const,
      progressSummary: presentation.progressSummary,
    }
  }
  return {
    prompt: undefined,
    autoReply: presentation.autoReply,
    statusText: presentation.statusText,
  }
}

export function permissionPromptAfterRunDone<Prompt>(current: Prompt | undefined, status: string) {
  return ["completed", "cancelled", "failed", "blocked"].includes(status) ? undefined : current
}

export function sidecarPermissionReply(action: PermissionReplyAction): SidecarPermissionReply {
  return action === "approve" ? "once" : "reject"
}
