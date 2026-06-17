import { randomUUID } from "node:crypto"
import type { PermissionAction } from "./message"
import { containsSensitivePath } from "./bash-safety"

export type PermissionRule = {
  permission: string
  pattern: string
  action: PermissionAction
}

export type SubagentPermissionRole = "summary" | "explorer" | "reviewer" | "debugger" | "tester" | "docs_researcher"

export type PermissionReply = "once" | "always" | "reject"
export type PermissionAutoReviewResult = {
  reply: PermissionReply
  source: string
  reason?: string
}
export type PermissionAutoReviewer = (request: PermissionRequest) => PermissionReply | PermissionAutoReviewResult | undefined | Promise<PermissionReply | PermissionAutoReviewResult | undefined>
export type PermissionAuthorization = {
  source: "preapproved" | "auto_review" | "manual" | "external_reply"
  reply?: PermissionReply
  autoReviewSource?: string
  reason?: string
  rememberedPatterns?: string[]
}

export type PermissionRequest = {
  id: string
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

export type PermissionDecision = {
  pattern: string
  action: PermissionAction
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

function nextPermissionID() {
  return `perm_${randomUUID()}`
}

function escapeRegExp(input: string) {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

const patternCacheLimit = 16
const patternCache = new Map<string, RegExp>()

function patternRegExp(pattern: string) {
  const normalized = pattern.replaceAll("\\", "/")
  const cached = patternCache.get(normalized)
  if (cached) {
    patternCache.delete(normalized)
    patternCache.set(normalized, cached)
    return cached
  }
  const source = `^${normalized.split("*").map(escapeRegExp).join(".*")}$`
  const regexp = new RegExp(source)
  patternCache.set(normalized, regexp)
  if (patternCache.size > patternCacheLimit) {
    // Note: Map.prototype.keys().next().value returns the first key in insertion order.
    // In V8, Map iterator traversal starts from the beginning of the insertion list,
    // making next() conceptually O(1) in practice, thus achieving O(1) LRU eviction.
    const oldest = patternCache.keys().next().value
    if (oldest !== undefined) patternCache.delete(oldest)
  }
  return regexp
}

export function matchPattern(pattern: string, value: string) {
  return patternRegExp(pattern).test(value.replaceAll("\\", "/"))
}

function isSafeProjectRootEditPattern(pattern: string) {
  const normalized = pattern.replaceAll("\\", "/").trim()

  // Must not be an absolute path
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return false
  }

  // Must not escape the root
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    return false
  }

  // Must not contain sensitive path names (like .env or secrets)
  if (containsSensitivePath(normalized)) {
    return false
  }

  return true
}

export function evaluatePermission(permission: string, pattern: string, rules: PermissionRule[]): PermissionAction {
  const matches = rules.filter((rule) => matchPattern(rule.permission, permission) && matchPattern(rule.pattern, pattern))

  // If the permission is edit/write, and we only matched catch-all rule(s) (pattern === "*"),
  // we can relax the permission to "allow" if the file is inside the project root and not sensitive.
  if ((permission === "edit" || permission === "write") && isSafeProjectRootEditPattern(pattern)) {
    const hasSpecificRule = matches.some((rule) => rule.pattern !== "*" && rule.permission === permission)
    if (!hasSpecificRule) {
      const wildcardMatches = matches.filter((rule) => rule.permission === permission && rule.pattern === "*")
      if (wildcardMatches.length === matches.filter((rule) => rule.permission === permission).length) {
        return "allow"
      }
    }
  }

  if (matches.some((rule) => rule.action === "deny")) return "deny"
  if (matches.some((rule) => rule.action === "ask")) return "ask"
  if (matches.some((rule) => rule.action === "allow")) return "allow"
  return "ask"
}

type PendingPermission = {
  request: PermissionRequest
  resolve: (authorization: PermissionAuthorization) => void
  reject: (error: Error) => void
}

export class PermissionService {
  readonly rules: PermissionRule[]
  readonly approved: PermissionRule[] = []
  readonly pending = new Map<string, PermissionRequest>()
  private readonly waiters = new Map<string, PendingPermission>()
  private readonly askHandler?: (request: PermissionRequest) => PermissionReply | Promise<PermissionReply>
  private autoReviewer?: PermissionAutoReviewer

  constructor(rules: PermissionRule[], askHandler?: (request: PermissionRequest) => PermissionReply | Promise<PermissionReply>, autoReviewer?: PermissionAutoReviewer) {
    this.rules = rules
    this.askHandler = askHandler
    this.autoReviewer = autoReviewer
  }

  static autoApprove(rules: PermissionRule[]) {
    return new PermissionService(rules, () => "once")
  }

  /**
   * Creates a mode-specific service with a snapshot of current approvals.
   * Later approvals are intentionally isolated between parent and child.
   */
  withRules(rules: PermissionRule[]) {
    const service = new PermissionService(rules, this.askHandler, this.autoReviewer)
    service.approved.push(...this.approved)
    return service
  }

  withAutoReviewer(autoReviewer: PermissionAutoReviewer) {
    const previous = this.autoReviewer
    const chained: PermissionAutoReviewer = async (request) => {
      const first = await previous?.(request)
      return first ?? autoReviewer(request)
    }
    this.autoReviewer = chained
    return this
  }

  evaluate(permission: string, pattern: string): PermissionAction {
    const base = evaluatePermission(permission, pattern, this.rules)
    if (base === "deny") return "deny"
    if (this.approved.some((rule) => rule.action === "allow" && matchPattern(rule.permission, permission) && matchPattern(rule.pattern, pattern))) return "allow"
    return base
  }

  async authorize(input: Omit<PermissionRequest, "id">, evaluatedDecisions?: PermissionDecision[]) {
    const decisions = evaluatedDecisions ?? input.patterns.map((pattern) => ({ pattern, action: this.evaluate(input.permission, pattern) }))
    const denied = decisions.filter((decision) => decision.action === "deny")
    if (denied.length > 0) {
      throw new PermissionDeniedError(
        [...this.rules, ...this.approved].filter((rule) => rule.action === "deny" && matchPattern(rule.permission, input.permission)),
      )
    }
    if (decisions.every((decision) => decision.action === "allow")) return { source: "preapproved" } satisfies PermissionAuthorization

    const request: PermissionRequest = { id: nextPermissionID(), ...input }
    if (this.autoReviewer) {
      const reviewed = normalizeAutoReviewResult(await this.autoReviewer(request))
      if (reviewed) {
        return this.applyReply(request, reviewed.reply, {
          source: "auto_review",
          autoReviewSource: reviewed.source,
          reason: reviewed.reason,
        })
      }
    }
    if (this.askHandler) {
      return this.applyReply(request, await this.askHandler(request), { source: "manual" })
    }

    return await new Promise<PermissionAuthorization>((resolve, reject) => {
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

  private applyReply(request: PermissionRequest, reply: PermissionReply, base: Pick<PermissionAuthorization, "source" | "autoReviewSource" | "reason"> = { source: "external_reply" }) {
    const pending = this.waiters.get(request.id)
    this.pending.delete(request.id)
    this.waiters.delete(request.id)
    if (reply === "reject") {
      const error = new PermissionRejectedError()
      pending?.reject(error)
      throw error
    }
    if (reply === "always") {
      this.remember(request.permission, request.always)
    }
    let rememberedPatterns: string[] | undefined
    if (reply === "once" && request.metadata.rememberOnApprove === true) {
      rememberedPatterns = metadataStringList(request.metadata.rememberPatterns) ?? request.patterns
      this.remember(request.permission, rememberedPatterns)
    }
    const authorization = { ...base, reply, rememberedPatterns } satisfies PermissionAuthorization
    pending?.resolve(authorization)
    return authorization
  }

  private remember(permission: string, patterns: string[]) {
    for (const pattern of patterns) {
      if (this.approved.some((rule) => rule.permission === permission && rule.pattern === pattern && rule.action === "allow")) continue
      this.approved.push({ permission, pattern, action: "allow" })
    }
  }
}

function normalizeAutoReviewResult(result: PermissionReply | PermissionAutoReviewResult | undefined): PermissionAutoReviewResult | undefined {
  if (!result) return undefined
  if (typeof result === "string") return { reply: result, source: "auto_reviewer" }
  return result
}

function metadataStringList(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined
  return value
}

export function defaultPermissionAutoReviewer(request: PermissionRequest): PermissionAutoReviewResult | undefined {
  if (request.permission === "skill" && request.patterns.every(isSafeSkillName)) return { reply: "once", source: "default_auto_reviewer", reason: "safe skill name" }
  if (request.permission !== "bash") return undefined
  if (request.metadata.rememberOnApprove !== true) return undefined
  const command = typeof request.metadata.command === "string" ? request.metadata.command : undefined
  if (command && containsSensitivePath(command)) return undefined
  const tool = typeof request.metadata.tool === "string" ? request.metadata.tool : "bash"
  if (tool === "bash" && command && isAutoApprovedVerificationBashCommand(command)) return { reply: "once", source: "default_auto_reviewer", reason: "bounded verification command" }
  const matcher = tool === "bash" ? isAutoApprovedReadonlyFallbackBashPattern : isAutoApprovedReadonlyInternalToolPattern
  if (!request.patterns.every(matcher)) return undefined
  return { reply: "once", source: "default_auto_reviewer", reason: "repeat-safe readonly scope" }
}

function isSafeSkillName(value: string) {
  return Boolean(value) && !value.includes("..") && !value.includes("\\") && !value.startsWith("/")
}

function isAutoApprovedReadonlyFallbackBashPattern(pattern: string) {
  return /^bash:readonly:(pwd|ls|find|wc):/i.test(pattern)
}

function isAutoApprovedReadonlyInternalToolPattern(pattern: string) {
  return /^bash:readonly:/i.test(pattern)
}

function isAutoApprovedVerificationBashCommand(command: string) {
  const trimmed = command.trim()
  if (!trimmed || /[;&|><`$]/.test(trimmed)) return false
  return /^(bun test|bun run test|bun run build|bun run typecheck|bun run verify|bun run gate|bunx vitest|bun x vitest|npm test|npm run test|npm run build|npm run typecheck|npm run verify|pnpm test|pnpm run test|pnpm run build|pnpm run typecheck|pnpm run verify|pnpm exec tsc|pnpm exec vitest|npx tsc|npx vitest|go test|cargo test|pytest|python -m pytest|node --test|vitest|jest|mocha)(?:\s+.+)?$/i.test(trimmed)
}

export function defaultPermissionRules(mode: "build" | "plan" | "goal"): PermissionRule[] {
  const base: PermissionRule[] = [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "secrets/*", action: "deny" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "write", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    ...bashSafetyPermissionRules(),
    { permission: "skill", pattern: "*", action: "ask" },
    { permission: "mcp", pattern: "*", action: "allow" },
    { permission: "web_search", pattern: "*", action: "allow" },
    { permission: "web_fetch", pattern: "*", action: "allow" },
    { permission: "delegate_subagent", pattern: "*", action: mode === "build" || mode === "goal" ? "allow" : "deny" },
    { permission: "plan_exit", pattern: "*", action: "allow" },
    { permission: "plan_step_complete", pattern: "*", action: mode === "build" || mode === "goal" ? "allow" : "deny" },
    { permission: "plan_step_fail", pattern: "*", action: mode === "build" || mode === "goal" ? "allow" : "deny" },
    { permission: "goal_set_acceptance", pattern: "*", action: mode === "build" || mode === "plan" || mode === "goal" ? "allow" : "deny" },
    { permission: "goal_complete", pattern: "*", action: mode === "build" || mode === "plan" || mode === "goal" ? "allow" : "deny" },
    { permission: "goal_blocked", pattern: "*", action: mode === "build" || mode === "plan" || mode === "goal" ? "allow" : "deny" },
  ]
  base.push({ permission: "bash", pattern: "*", action: "allow" })
  return base
}

function bashSafetyPermissionRules(): PermissionRule[] {
  return [
    { permission: "bash", pattern: "rm*", action: "deny" },
    { permission: "bash", pattern: "rmdir*", action: "deny" },
    { permission: "bash", pattern: "unlink*", action: "deny" },
    { permission: "bash", pattern: "trash*", action: "deny" },
    { permission: "bash", pattern: "find* -delete*", action: "deny" },
    { permission: "bash", pattern: "git clean*", action: "deny" },
    { permission: "bash", pattern: "git push*", action: "deny" },
    { permission: "bash", pattern: "git pull*", action: "deny" },
    { permission: "bash", pattern: "git fetch*", action: "deny" },
    { permission: "bash", pattern: "git clone*", action: "deny" },
    { permission: "bash", pattern: "git remote*", action: "deny" },
    { permission: "bash", pattern: "git ls-remote*", action: "deny" },
    { permission: "bash", pattern: "git submodule*--remote*", action: "deny" },
    { permission: "bash", pattern: "bash:review:*", action: "ask" },
  ]
}

export function defaultSubagentPermissionRules(role: SubagentPermissionRole): PermissionRule[] {
  void role
  const base: PermissionRule[] = [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "secrets/*", action: "deny" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "write", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "mcp", pattern: "*", action: "allow" },
    { permission: "web_search", pattern: "*", action: "allow" },
    { permission: "web_fetch", pattern: "*", action: "allow" },
    { permission: "delegate_subagent", pattern: "*", action: "deny" },
    { permission: "plan_exit", pattern: "*", action: "deny" },
    { permission: "plan_step_complete", pattern: "*", action: "deny" },
    { permission: "plan_step_fail", pattern: "*", action: "deny" },
  ]
  return [
    ...base,
    ...bashSafetyPermissionRules(),
    { permission: "bash", pattern: "*", action: "allow" },
  ]
}
