import { describe, expect, test } from "bun:test"
import { effectivePermissionMode, permissionModeLabel, permissionPromptAfterRunDone, permissionPromptFromRequest, permissionRequestPresentation, permissionRequiredSummary, permissionRunSnapshot, permissionUiAfterRequest, shouldShowPermissionPrompt, sidecarPermissionMode, sidecarPermissionReply } from "../../apps/desktop/src/renderer/permission-state"

describe("desktop permission state", () => {
  test("uses ask or auto-review for build and plan runs", () => {
    expect(effectivePermissionMode("build", "ask")).toBe("ask")
    expect(effectivePermissionMode("plan", "auto-review")).toBe("auto-review")
    expect(sidecarPermissionMode("build", "auto-review")).toBe("auto-review")
    expect(sidecarPermissionMode("plan", "ask")).toBe("ask")
  })

  test("forces goal runs through the restricted CLI goal permission path", () => {
    expect(effectivePermissionMode("goal", "ask")).toBe("goal-restricted")
    expect(effectivePermissionMode("goal", "auto-review")).toBe("goal-restricted")
    expect(sidecarPermissionMode("goal", "auto-review")).toBe("ask")
    expect(permissionModeLabel("goal-restricted")).toBe("Goal restricted")
  })

  test("captures the permission mode used by a specific run", () => {
    expect(permissionRunSnapshot("build", "auto-review")).toEqual({
      runMode: "build",
      permissionMode: "auto-review",
      effectiveMode: "auto-review",
      sidecarMode: "auto-review",
    })
    expect(permissionRunSnapshot("goal", "auto-review")).toEqual({
      runMode: "goal",
      permissionMode: "auto-review",
      effectiveMode: "goal-restricted",
      sidecarMode: "ask",
    })
  })

  test("formats permission request prompts without inventing extra choices", () => {
    const request = { id: "permission_1", permission: "edit", patterns: [".env", "secrets/*"] }

    expect(permissionPromptFromRequest(request)).toEqual({
      requestId: "permission_1",
      title: "edit: .env, secrets/*",
      detail: "EasyCode needs approval before continuing this local operation.",
    })
    expect(permissionRequiredSummary(request)).toBe("Permission required: edit: .env, secrets/*")
    expect(permissionModeLabel("ask")).toBe("Ask")
    expect(permissionModeLabel("auto-review")).toBe("Auto-review")
  })

  test("shows manual permission prompts only for Ask mode", () => {
    expect(shouldShowPermissionPrompt("ask")).toBe(true)
    expect(shouldShowPermissionPrompt("auto-review")).toBe(false)
    expect(shouldShowPermissionPrompt("goal-restricted")).toBe(false)
  })

  test("presents sidecar permission requests according to the active run snapshot", () => {
    const request = { id: "permission_1", permission: "edit", patterns: [".env"] }

    expect(permissionRequestPresentation("ask", request)).toEqual({
      showPrompt: true,
      progressSummary: "Permission required: edit: .env",
      prompt: {
        requestId: "permission_1",
        title: "edit: .env",
        detail: "EasyCode needs approval before continuing this local operation.",
      },
    })
    expect(permissionRequestPresentation("auto-review", request)).toEqual({
      showPrompt: false,
      autoReply: "reject",
      statusText: "Ignored unexpected manual permission request: Permission required: edit: .env",
    })
    expect(permissionRequestPresentation("goal-restricted", request)).toEqual({
      showPrompt: false,
      autoReply: "reject",
      statusText: "Ignored unexpected manual permission request: Permission required: edit: .env",
    })
  })

  test("maps permission request events to concrete UI state updates", () => {
    const request = { id: "permission_1", permission: "edit", patterns: [".env"] }

    expect(permissionUiAfterRequest("ask", request)).toEqual({
      prompt: {
        requestId: "permission_1",
        title: "edit: .env",
        detail: "EasyCode needs approval before continuing this local operation.",
      },
      progressStatus: "waiting_permission",
      progressSummary: "Permission required: edit: .env",
    })
    expect(permissionUiAfterRequest("auto-review", request)).toEqual({
      prompt: undefined,
      autoReply: "reject",
      statusText: "Ignored unexpected manual permission request: Permission required: edit: .env",
    })
    expect(permissionUiAfterRequest("goal-restricted", request)).toEqual({
      prompt: undefined,
      autoReply: "reject",
      statusText: "Ignored unexpected manual permission request: Permission required: edit: .env",
    })
  })

  test("clears visible permission prompts after terminal run completion", () => {
    const prompt = {
      requestId: "permission_1",
      title: "edit: .env",
      detail: "EasyCode needs approval before continuing this local operation.",
    }

    expect(permissionPromptAfterRunDone(prompt, "completed")).toBeUndefined()
    expect(permissionPromptAfterRunDone(prompt, "cancelled")).toBeUndefined()
    expect(permissionPromptAfterRunDone(prompt, "failed")).toBeUndefined()
    expect(permissionPromptAfterRunDone(prompt, "blocked")).toBeUndefined()
    expect(permissionPromptAfterRunDone(prompt, "running")).toBe(prompt)
  })

  test("maps modal actions to exact sidecar permission replies", () => {
    expect(sidecarPermissionReply("approve")).toBe("once")
    expect(sidecarPermissionReply("reject")).toBe("reject")
  })
})
