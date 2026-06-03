import type { Message, ToolInvocation } from "../../message"
import { toolInvocations } from "../../message"

const duplicateValidatedTools = new Set([
  "read",
  "read_lines",
  "grep",
  "rg_search",
  "find_definition",
  "find_references",
  "call_graph",
  "repo_map",
  "list",
  "git_diff",
  "git_status",
  "git_branch",
  "git_log",
  "ledger",
  "memory_query",
  "connector_list",
  "mcp_list_resources",
  "mcp_read_resource",
  "web_search",
])
const invalidatingTools = new Set(["edit", "write", "patch", "bash", "connector_call", "git_restore_guarded"])

export type DuplicateInspection = {
  toolName: string
  fingerprint: string
  description: string
}

export function findDuplicateInspection(messages: Message[], toolName: string, input: unknown): DuplicateInspection | undefined {
  const fingerprint = inspectionFingerprint(toolName, input)
  if (!fingerprint) return undefined
  const seen = seenInspectionKeys(messages)
  const key = duplicateInspectionKey(toolName, fingerprint)
  if (!seen.has(key)) return undefined
  return { toolName, fingerprint, description: describeInspection(toolName, input) }
}

export function collectDuplicateInspections(messages: Message[]): DuplicateInspection[] {
  const duplicates: DuplicateInspection[] = []
  const seen = new Set<string>()
  const emitted = new Set<string>()
  for (const invocation of recentInvocations(messages)) {
    if (isInvalidatingInvocation(invocation)) {
      seen.clear()
      continue
    }
    if (invocation.status !== "succeeded") continue
    const fingerprint = inspectionFingerprint(invocation.toolName, invocation.input)
    if (!fingerprint) continue
    const key = duplicateInspectionKey(invocation.toolName, fingerprint)
    if (!seen.has(key)) {
      seen.add(key)
      continue
    }
    if (emitted.has(key)) continue
    emitted.add(key)
    duplicates.push({
      toolName: invocation.toolName,
      fingerprint,
      description: describeInspection(invocation.toolName, invocation.input),
    })
  }
  return duplicates
}

function seenInspectionKeys(messages: Message[]) {
  const seen = new Set<string>()
  for (const invocation of recentInvocations(messages)) {
    if (isInvalidatingInvocation(invocation)) {
      seen.clear()
      continue
    }
    if (invocation.status !== "succeeded") continue
    const fingerprint = inspectionFingerprint(invocation.toolName, invocation.input)
    if (!fingerprint) continue
    seen.add(duplicateInspectionKey(invocation.toolName, fingerprint))
  }
  return seen
}

function recentInvocations(messages: Message[]) {
  const start = Math.max(0, messages.map((message, index) => ({ role: message.role, index })).filter((item) => item.role === "user").at(-1)?.index ?? 0)
  return toolInvocations(messages.slice(start))
}

function isInvalidatingInvocation(invocation: ToolInvocation) {
  return invocation.status === "succeeded" && invalidatingTools.has(invocation.toolName)
}

function duplicateInspectionKey(toolName: string, fingerprint: string) {
  return `${toolName}:${fingerprint}`
}

function inspectionFingerprint(toolName: string, input: unknown) {
  if (!duplicateValidatedTools.has(toolName)) return undefined
  return stableStringify(normalizeInspectionInput(toolName, input))
}

function normalizeInspectionInput(toolName: string, input: unknown) {
  if (!input || typeof input !== "object") return input
  if (toolName === "list") {
    const dirPath = (input as { dirPath?: unknown }).dirPath
    return { dirPath: typeof dirPath === "string" && dirPath.length > 0 ? dirPath : "." }
  }
  return input
}

function describeInspection(toolName: string, input: unknown) {
  if (!input || typeof input !== "object") return toolName
  if (toolName === "read") {
    const filePath = (input as { filePath?: unknown }).filePath
    return typeof filePath === "string" ? `read ${filePath}` : toolName
  }
  if (toolName === "read_lines") {
    const filePath = (input as { filePath?: unknown }).filePath
    const startLine = (input as { startLine?: unknown }).startLine
    const endLine = (input as { endLine?: unknown }).endLine
    if (typeof filePath === "string" && typeof startLine === "number" && typeof endLine === "number") {
      return `read_lines ${filePath}:${startLine}-${endLine}`
    }
    return toolName
  }
  if (toolName === "grep" || toolName === "rg_search") {
    const query = (input as { query?: unknown }).query
    const dir = (input as { dir?: unknown }).dir
    if (typeof query === "string") return `${toolName} query=${JSON.stringify(query)} dir=${JSON.stringify(typeof dir === "string" ? dir : ".")}`
  }
  if (toolName === "git_status" || toolName === "git_branch" || toolName === "git_log" || toolName === "ledger" || toolName === "memory_query" || toolName === "connector_list") {
    return toolName
  }
  return `${toolName} ${stableStringify(input)}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`
}
