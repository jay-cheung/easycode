import type { LedgerKind, LedgerRecord, LedgerScope, LedgerStatus } from "../context"
import type { ToolCall } from "../message"

export function ledgerRecord(kind: LedgerKind, subject: string, value: string, status: LedgerStatus, turn: number, input: { scope?: LedgerScope; reason?: string; evidence?: LedgerRecord["evidence"] } = {}): LedgerRecord {
  return {
    id: `run_${kind}_${hashLedgerID(`${subject}\n${value}\n${JSON.stringify(input.scope ?? {})}`)}`,
    kind,
    subject,
    value,
    status,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    createdAtTurn: turn,
    updatedAtTurn: turn,
  }
}

export function toolScopeFiles(call: ToolCall, result?: { metadata: Record<string, unknown> }) {
  const files = new Set<string>()
  collectFileRefs(call.input, files)
  collectFileRefs(result?.metadata.changed, files)
  return [...files]
}

function collectFileRefs(value: unknown, output: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|css|html|go|py|rs|toml|yaml|yml)/g)) {
      output.add(match[0].replaceAll("\\", "/").replace(/^\.\//, ""))
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileRefs(item, output)
    return
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectFileRefs(item, output)
  }
}

function hashLedgerID(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

