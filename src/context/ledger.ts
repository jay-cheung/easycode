import { messagesToProviderInput, type Message } from "../message"
import { estimateTextTokens } from "./tokens"
import type { ContextLedger, LedgerEvidence, LedgerKind, LedgerRecord, LedgerScope, LedgerStatus, StructuredContextLedger } from "./types"

const currentAlwaysKinds = new Set<LedgerKind>(["intent", "decision", "constraint", "preference", "entity", "failure", "conflict"])
const currentAlwaysSubjects = new Set([
  "current_user_request",
  "current_user_input",
  "main_objective",
  "active_skills",
  "pending_skill_loads",
  "active_mcp_servers",
  "active_mcp_resources",
  "active_connectors",
  "active_web_search_engine",
  "active_capability_surface",
  "current_plan_id",
  "current_plan_step",
  "plan_step_status",
  "plan_blocker",
  "plan_verification_target",
  "plan_last_replan_reason",
  "plan_step_status_map",
  "plan_lifecycle_status",
  "current_session_id",
])
// History is selected only when the latest request asks for prior context; match
// both English and Chinese because the ledger is shared across bilingual turns.
const historyTriggerPattern = /\b(previous|prior|rollback|revert|why|reason|tried|rejected|superseded)\b|之前|以前|回退|为什么|原因|试过|拒绝|废弃|覆盖/i

export function renderContextLedger(ledger: StructuredContextLedger | ContextLedger | undefined) {
  const normalized = normalizedLedger(ledger)
  if (!normalized) return ""
  const lines = ["<context_state_ledger>"]
  for (const record of ledgerRecordsInTimelineOrder(normalized)) lines.push(`- ${formatLedgerRecord(record)}`)
  lines.push("</context_state_ledger>")
  return lines.join("\n")
}

/**
 * Convert partial ledger input into a structured ledger and drop empty/invalid
 * records. Current records stay current; all other statuses move to history.
 */
export function normalizedLedger(ledger: StructuredContextLedger | ContextLedger | undefined): StructuredContextLedger | undefined {
  if (!ledger) return undefined
  const records: LedgerRecord[] = []
  if (Array.isArray(ledger.current)) records.push(...ledger.current)
  if (Array.isArray(ledger.history)) records.push(...ledger.history)
  if (!records.length) return undefined
  const normalizedRecords = records.map(normalizeLedgerRecord).filter((record): record is LedgerRecord => Boolean(record))
  const current: LedgerRecord[] = []
  const history: LedgerRecord[] = []
  for (const record of normalizedRecords) {
    if (record.status === "current") current.push(record)
    else history.push(record)
  }
  return normalizeStructuredLedger({ current, history })
}

/**
 * Merge a ledger patch into the current ledger by stable record key.
 * Replaced current records are retained as history so rejected/superseded
 * context remains available when a later request asks for prior decisions.
 */
export function mergeLedger(current: StructuredContextLedger | undefined, patch: ContextLedger) {
  const base = normalizedLedger(current) ?? emptyLedger()
  const incoming = normalizedLedger(patch) ?? emptyLedger()
  const next = { current: [...base.current], history: [...base.history] }
  for (const record of [...incoming.current, ...incoming.history]) {
    const match = removeCurrentMatches(next.current, record)
    next.current = match.current
    if (match.alreadyCurrent) continue
    next.history.push(...replacedCurrentRecords(match.replaced, record))
    if (record.status === "current") next.current.push(currentRecordWithSupersedes(record, match.replaced))
    else next.history.push(record)
  }
  return normalizeStructuredLedger(next)
}

function removeCurrentMatches(current: LedgerRecord[], record: LedgerRecord) {
  const key = ledgerRecordKey(record)
  const replaced: LedgerRecord[] = []
  let alreadyCurrent = false
  const remaining = current.filter((existing) => {
    if (ledgerRecordKey(existing) !== key) return true
    if (sameLedgerRecordContent(existing, record)) {
      alreadyCurrent = true
      return true
    }
    replaced.push(existing)
    return false
  })
  return { current: remaining, replaced, alreadyCurrent }
}

function replacedCurrentRecords(replaced: LedgerRecord[], record: LedgerRecord) {
  return replaced.map((existing) => {
    const status = record.status === "current" ? "superseded" : record.status
    return { ...existing, status, updatedAtTurn: Math.max(existing.updatedAtTurn, record.updatedAtTurn), supersedes: uniqueStrings([...(existing.supersedes ?? []), record.id]) }
  })
}

function currentRecordWithSupersedes(record: LedgerRecord, replaced: LedgerRecord[]) {
  return { ...record, supersedes: uniqueStrings([...(record.supersedes ?? []), ...replaced.map((item) => item.id)]) }
}

function sameLedgerRecordContent(left: LedgerRecord, right: LedgerRecord) {
  return left.kind === right.kind &&
    left.subject === right.subject &&
    left.value === right.value &&
    left.status === right.status &&
    (left.reason ?? "") === (right.reason ?? "") &&
    scopeKey(left.scope) === scopeKey(right.scope) &&
    evidenceKey(left.evidence) === evidenceKey(right.evidence)
}

function emptyLedger(): StructuredContextLedger {
  return { current: [], history: [] }
}

function ledgerRecordsInTimelineOrder(ledger: StructuredContextLedger) {
  return [...ledger.history, ...ledger.current].sort((left, right) =>
    left.updatedAtTurn - right.updatedAtTurn ||
    left.createdAtTurn - right.createdAtTurn ||
    left.subject.localeCompare(right.subject) ||
    left.id.localeCompare(right.id)
  )
}

const maxHistoryRecords = 25

function normalizeStructuredLedger(ledger: StructuredContextLedger): StructuredContextLedger | undefined {
  const current = dedupeRecords(ledger.current)
  const history = dedupeRecords(ledger.history).sort((left, right) => right.updatedAtTurn - left.updatedAtTurn).slice(0, maxHistoryRecords)
  if (!current.length && !history.length) return undefined
  return { current, history }
}

function dedupeRecords(records: LedgerRecord[]) {
  const seen = new Set<string>()
  const result: LedgerRecord[] = []
  for (const record of records) {
    const key = record.id
    if (seen.has(key)) continue
    seen.add(key)
    result.push(record)
  }
  return result
}

function normalizeLedgerRecord(input: Partial<LedgerRecord> | undefined): LedgerRecord | undefined {
  if (!input?.kind || !input.subject || !input.value) return undefined
  const status = isLedgerStatus(input.status) ? input.status : "current"
  const createdAtTurn = safeTurn(input.createdAtTurn)
  const updatedAtTurn = safeTurn(input.updatedAtTurn ?? createdAtTurn)
  const record: LedgerRecord = {
    id: input.id || stableLedgerID(input.kind, input.subject, input.value, input.scope),
    kind: input.kind,
    subject: compactLedgerText(input.subject),
    value: compactLedgerText(input.value),
    status,
    createdAtTurn,
    updatedAtTurn,
  }
  const scope = normalizeLedgerScope(input.scope)
  if (scope) record.scope = scope
  if (input.reason) record.reason = compactLedgerText(input.reason)
  if (input.evidence) record.evidence = input.evidence
  if (input.supersedes?.length) record.supersedes = uniqueStrings(input.supersedes)
  return record
}

/**
 * Select ledger records relevant to the latest messages and fit them to the
 * dynamic token budget used by the ledger tool.
 */
export function selectContextLedger(ledger: StructuredContextLedger | ContextLedger | undefined, messages: Message[], tokenBudget: number) {
  const normalized = normalizedLedger(ledger)
  if (!normalized) return undefined
  const signal = ledgerSelectionSignal(messages)
  const includeHistory = historyTriggerPattern.test(signal.text)
  const current = normalized.current.filter((record) => isAlwaysCurrent(record) || recordRelevant(record, signal))
  const currentKeys = new Set(current.map(ledgerRecordKey))
  const history = normalized.history.filter((record) => {
    const related = currentKeys.has(ledgerRecordKey(record)) || recordRelevant(record, signal) || recordMentioned(record, signal)
    if (!related) return false
    if (!includeHistory && !currentKeys.has(ledgerRecordKey(record)) && !recordRelevant(record, signal)) return false
    return record.status === "rejected" || record.status === "superseded" || record.status === "resolved" || recordRelevant(record, signal)
  })
  return fitLedgerToBudget({ current: sortRecords(current), history: sortRecords(history) }, tokenBudget)
}

function fitLedgerToBudget(ledger: StructuredContextLedger, tokenBudget: number) {
  const selected = emptyLedger()
  const ranked = [...ledger.current.map((record) => ({ record, tier: currentRecordTier(record), bucket: "current" as const })), ...ledger.history.map((record) => ({ record, tier: historyRecordTier(record), bucket: "history" as const }))]
    .sort((left, right) => left.tier - right.tier || right.record.updatedAtTurn - left.record.updatedAtTurn)
  for (const item of ranked) {
    const candidate = item.bucket === "current"
      ? { current: [...selected.current, item.record], history: selected.history }
      : { current: selected.current, history: [...selected.history, item.record] }
    if (estimateTextTokens(renderContextLedger(candidate)) > tokenBudget && selected.current.length + selected.history.length > 0) continue
    if (item.bucket === "current") selected.current.push(item.record)
    else selected.history.push(item.record)
  }
  return normalizeStructuredLedger(selected)
}

function currentRecordTier(record: LedgerRecord) {
  if (record.kind === "intent" || record.kind === "constraint") return 0
  if (record.kind === "failure" || record.kind === "conflict") return 1
  if (record.kind === "preference") return 2
  if (record.kind === "file") return 3
  return 4
}

function historyRecordTier(record: LedgerRecord) {
  if (record.status === "rejected" || record.status === "superseded") return 5
  if (record.status === "resolved") return 6
  return 7
}

function isAlwaysCurrent(record: LedgerRecord) {
  return record.status === "current" && (currentAlwaysKinds.has(record.kind) || currentAlwaysSubjects.has(record.subject))
}

function recordRelevant(record: LedgerRecord, signal: LedgerSelectionSignal) {
  const haystack = `${record.subject} ${record.value} ${record.scope?.topics?.join(" ") ?? ""} ${record.scope?.symbols?.join(" ") ?? ""}`.toLowerCase()
  if (signal.keywords.some((keyword) => keyword.length >= 3 && haystack.includes(keyword))) return true
  for (const file of record.scope?.files ?? []) {
    if (signal.files.has(file) || signal.text.includes(file.toLowerCase()) || signal.text.includes(pathBasename(file).toLowerCase())) return true
  }
  return false
}

function recordMentioned(record: LedgerRecord, signal: LedgerSelectionSignal) {
  return ledgerMentionTerms(record).some((term) => term.length >= 2 && signal.text.includes(term))
}

function ledgerMentionTerms(record: LedgerRecord) {
  return uniqueStrings([record.subject, ...record.value.toLowerCase().split(/[:：,，.。()（）\s]+/), ...(record.scope?.topics ?? []), ...(record.scope?.symbols ?? [])].map((item) => item.toLowerCase()))
}

type LedgerSelectionSignal = {
  text: string
  files: Set<string>
  keywords: string[]
}

function ledgerSelectionSignal(messages: Message[]): LedgerSelectionSignal {
  const recent = messages.slice(-8)
  const text = messagesToProviderInput(recent).map((message) => message.content).join("\n").toLowerCase()
  const files = new Set(extractFileRefs(text))
  const keywords = uniqueStrings(text.split(/[^A-Za-z0-9_.\/-]+/).filter((item) => item.length >= 3 && item.length <= 80))
  return { text, files, keywords }
}

function extractFileRefs(text: string) {
  const matches = text.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|css|html|go|py|rs|toml|yaml|yml)/g)
  return uniqueStrings([...matches].map((match) => normalizePathRef(match[0])))
}

function normalizePathRef(input: string) {
  return input.replaceAll("\\", "/").replace(/^\.\//, "")
}

function pathBasename(input: string) {
  const normalized = normalizePathRef(input)
  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

function sortRecords(records: LedgerRecord[]) {
  return [...records].sort((left, right) => currentRecordTier(left) - currentRecordTier(right) || right.updatedAtTurn - left.updatedAtTurn || left.subject.localeCompare(right.subject))
}

function formatLedgerRecord(record: LedgerRecord) {
  const parts = [`[${record.kind}/${record.status}] ${record.subject} = ${record.value}`]
  const scope = formatScope(record.scope)
  if (scope) parts.push(`scope: ${scope}`)
  if (record.reason) parts.push(`reason: ${record.reason}`)
  if (record.evidence) parts.push(`evidence: ${record.evidence.source}`)
  return parts.join(" | ")
}

function formatScope(scope: LedgerScope | undefined) {
  if (!scope) return ""
  const parts: string[] = []
  if (scope.taskID) parts.push(`task=${scope.taskID}`)
  if (scope.files?.length) parts.push(`files=${scope.files.join(",")}`)
  if (scope.symbols?.length) parts.push(`symbols=${scope.symbols.join(",")}`)
  if (scope.topics?.length) parts.push(`topics=${scope.topics.join(",")}`)
  return parts.join(";")
}

function ledgerRecordKey(record: LedgerRecord) {
  return `${record.kind}:${record.subject}:${scopeKey(record.scope)}`
}

function scopeKey(scope: LedgerScope | undefined) {
  if (!scope) return ""
  return stableStringify({
    taskID: scope.taskID,
    files: [...(scope.files ?? [])].sort(),
    symbols: [...(scope.symbols ?? [])].sort(),
    topics: [...(scope.topics ?? [])].sort(),
  })
}

function evidenceKey(evidence: LedgerEvidence | undefined) {
  if (!evidence) return ""
  return evidence.source
}

function normalizeLedgerScope(scope: LedgerScope | undefined) {
  if (!scope) return undefined
  const next: LedgerScope = {}
  if (scope.taskID) next.taskID = compactLedgerText(scope.taskID)
  if (scope.files?.length) next.files = uniqueStrings(scope.files.map(normalizePathRef).filter(Boolean))
  if (scope.symbols?.length) next.symbols = uniqueStrings(scope.symbols.map(compactLedgerText).filter(Boolean))
  if (scope.topics?.length) next.topics = uniqueStrings(scope.topics.map(compactLedgerText).filter(Boolean))
  return Object.keys(next).length ? next : undefined
}

/**
 * Detect summary text that contradicts current ledger records and emit conflict
 * records. This records the conflict; it does not override the current ledger.
 */
export function summaryLedgerConflicts(summary: string, ledger: StructuredContextLedger | undefined, turn: number) {
  const normalized = normalizedLedger(ledger)
  if (!normalized) return []
  const conflicts: LedgerRecord[] = []
  for (const record of normalized.current) {
    const escaped = record.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = summary.match(new RegExp(`${escaped}\\s*:\\s*([^\\n]+)`, "i"))
    if (!match || match[1]?.includes(record.value)) continue
    conflicts.push(normalizeLedgerRecord({
      kind: "conflict",
      subject: `summary_conflict:${record.subject}`,
      value: `summary says "${match[1]?.trim()}", current ledger says "${record.value}"`,
      status: "current",
      reason: "summary conflicts with current structured ledger; current ledger wins",
      evidence: { source: "summary" },
      createdAtTurn: turn,
      updatedAtTurn: turn,
    }) as LedgerRecord)
  }
  return conflicts
}

/**
 * Return structural ledger issues for diagnostics. Validation is non-throwing
 * so context planning can continue with best-effort ledger data.
 */
export function validateLedger(ledger: StructuredContextLedger | undefined) {
  if (!ledger) return []
  const issues: string[] = []
  const currentKeys = new Map<string, number>()
  for (const record of ledger.current) currentKeys.set(ledgerRecordKey(record), (currentKeys.get(ledgerRecordKey(record)) ?? 0) + 1)
  for (const [key, count] of currentKeys) if (count > 1) issues.push(`duplicate current record: ${key}`)
  for (const record of ledger.history) {
    if ((record.status === "rejected" || record.status === "superseded") && !record.reason && !record.supersedes?.length) issues.push(`missing reason for ${record.status}: ${record.subject}`)
    if (record.kind === "file" && !record.evidence) issues.push(`file record missing evidence: ${record.subject}`)
  }
  return issues
}

function stableLedgerID(kind: LedgerKind, subject: string, value: string, scope: LedgerScope | undefined) {
  return `ledger_${kind}_${hashText(`${subject}\n${value}\n${scopeKey(scope)}`)}`
}

function hashText(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function isLedgerStatus(value: unknown): value is LedgerStatus {
  return value === "current" || value === "superseded" || value === "rejected" || value === "resolved" || value === "archived"
}

function safeTurn(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function compactLedgerText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))]
}


export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
}
