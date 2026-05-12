import type { PermissionAction } from "./message"

export type PermissionRule = {
  permission: string
  pattern: string
  action: PermissionAction
}

export type PermissionReply = "once" | "always" | "reject"

export type PermissionRequest = {
  id: string
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

export class PermissionDeniedError extends Error {
  readonly rules: PermissionRule[]

  constructor(rules: PermissionRule[]) {
    super(`Permission denied by rule: ${rules.map((rule) => `${rule.permission}:${rule.pattern}`).join(", ")}`)
    this.name = "PermissionDeniedError"
    this.rules = rules
  }
}

export class PermissionRejectedError extends Error {
  constructor(message = "Permission rejected by user") {
    super(message)
    this.name = "PermissionRejectedError"
  }
}

let permissionCounter = 0

function nextPermissionID() {
  permissionCounter += 1
  return `perm_${Date.now().toString(36)}_${permissionCounter.toString(36)}`
}

function escapeRegExp(input: string) {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

export function matchPattern(pattern: string, value: string) {
  const normalized = pattern.replaceAll("\\", "/")
  const source = `^${normalized.split("*").map(escapeRegExp).join(".*")}$`
  return new RegExp(source).test(value.replaceAll("\\", "/"))
}

export function evaluatePermission(permission: string, pattern: string, rules: PermissionRule[]): PermissionAction {
  const matches = rules.filter((rule) => matchPattern(rule.permission, permission) && matchPattern(rule.pattern, pattern))
  if (matches.some((rule) => rule.action === "deny")) return "deny"
  if (matches.some((rule) => rule.action === "ask")) return "ask"
  if (matches.some((rule) => rule.action === "allow")) return "allow"
  return "ask"
}

type PendingPermission = {
  request: PermissionRequest
  resolve: () => void
  reject: (error: Error) => void
}

export class PermissionService {
  readonly rules: PermissionRule[]
  readonly approved: PermissionRule[] = []
  readonly pending = new Map<string, PermissionRequest>()
  private readonly waiters = new Map<string, PendingPermission>()
  private readonly askHandler?: (request: PermissionRequest) => PermissionReply | Promise<PermissionReply>

  constructor(rules: PermissionRule[], askHandler?: (request: PermissionRequest) => PermissionReply | Promise<PermissionReply>) {
    this.rules = rules
    this.askHandler = askHandler
  }

  static autoApprove(rules: PermissionRule[]) {
    return new PermissionService(rules, () => "once")
  }

  withRules(rules: PermissionRule[]) {
    const service = new PermissionService(rules, this.askHandler)
    service.approved.push(...this.approved)
    return service
  }

  evaluate(permission: string, pattern: string) {
    const base = evaluatePermission(permission, pattern, this.rules)
    if (base === "deny") return "deny"
    if (this.approved.some((rule) => rule.action === "allow" && matchPattern(rule.permission, permission) && matchPattern(rule.pattern, pattern))) return "allow"
    return base
  }

  async authorize(input: Omit<PermissionRequest, "id">) {
    const decisions = input.patterns.map((pattern) => ({ pattern, action: this.evaluate(input.permission, pattern) }))
    const denied = decisions.filter((decision) => decision.action === "deny")
    if (denied.length > 0) {
      throw new PermissionDeniedError(
        [...this.rules, ...this.approved].filter((rule) => rule.action === "deny" && matchPattern(rule.permission, input.permission)),
      )
    }
    if (decisions.every((decision) => decision.action === "allow")) return

    const request: PermissionRequest = { id: nextPermissionID(), ...input }
    if (this.askHandler) {
      this.applyReply(request, await this.askHandler(request))
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.pending.set(request.id, request)
      this.waiters.set(request.id, { request, resolve, reject })
    })
  }

  reply(requestID: string, reply: PermissionReply) {
    const pending = this.waiters.get(requestID)
    if (!pending) return false
    this.applyReply(pending.request, reply)
    return true
  }

  private applyReply(request: PermissionRequest, reply: PermissionReply) {
    const pending = this.waiters.get(request.id)
    this.pending.delete(request.id)
    this.waiters.delete(request.id)
    if (reply === "reject") {
      const error = new PermissionRejectedError()
      pending?.reject(error)
      throw error
    }
    if (reply === "always") {
      for (const pattern of request.always) this.approved.push({ permission: request.permission, pattern, action: "allow" })
    }
    pending?.resolve()
  }
}

export function defaultPermissionRules(mode: "build" | "plan"): PermissionRule[] {
  const base: PermissionRule[] = [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "secrets/*", action: "deny" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "write", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "rm -rf*", action: "deny" },
    { permission: "bash", pattern: "sudo*", action: "deny" },
    { permission: "bash", pattern: "git push*", action: "deny" },
    { permission: "bash", pattern: "docker*", action: "deny" },
    { permission: "bash", pattern: "*curl*|*sh*", action: "deny" },
    { permission: "skill", pattern: "*", action: "ask" },
    { permission: "plan_exit", pattern: "*", action: mode === "plan" ? "allow" : "deny" },
  ]
  if (mode === "build") return base
  return [...base, { permission: "write", pattern: "*", action: "deny" }, { permission: "edit", pattern: "*", action: "deny" }]
}
