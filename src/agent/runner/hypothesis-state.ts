import type { ContextManagerLike } from "../../context"
import { ledgerRecord } from "../ledger"
import { normalizeHypothesis, type ActiveHypothesis, type HypothesisViolation } from "../hypothesis"
import type { SkillInfo } from "../../skill"

export function compactLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export function truncateForLedger(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 15))}...[truncated]`
}

export function activeHypothesisFromLedger(ledger: ContextManagerLike["state"]["ledger"]): ActiveHypothesis | undefined {
  const record = ledger?.current?.find((item) => item.kind === "decision" && item.subject === "active_hypothesis")
  if (!record) return undefined
  const normalized = normalizeHypothesis(record.value)
  if (!normalized) return undefined
  return { summary: record.value, normalized, evidenceRevision: 0, updatedAtTurn: record.updatedAtTurn }
}

export function activeHypothesisMessages(activeHypothesis: ActiveHypothesis | undefined) {
  if (!activeHypothesis) return []
  return [{
    role: "system" as const,
    content: `Active hypothesis: ${activeHypothesis.summary}\nKeep executing this hypothesis unless new user or tool evidence appears. Do not replace it without citing the new evidence first.`,
  }]
}

export function updateActiveHypothesisState(
  context: ContextManagerLike,
  current: ActiveHypothesis | undefined,
  summary: string,
  normalized: string,
  evidenceRevision: number,
) {
  const turn = context.state.messages.length
  const next: ActiveHypothesis = {
    summary,
    normalized,
    evidenceRevision,
    updatedAtTurn: turn,
  }
  context.updateLedger({
    current: [
      ledgerRecord("decision", "active_hypothesis", truncateForLedger(summary, 220), "current", turn, {
        reason: `evidence revision ${evidenceRevision}`,
        evidence: { source: "assistant" },
      }),
    ],
  })
  return next
}

export function recordHypothesisViolationState(
  context: ContextManagerLike,
  activeHypothesis: ActiveHypothesis | undefined,
  violation: HypothesisViolation,
) {
  const turn = context.state.messages.length
  context.updateLedger({
    current: [
      ledgerRecord("failure", "hypothesis_drift_violation", truncateForLedger(violation.message, 240), "current", turn, {
        evidence: { source: "assistant" },
        scope: { topics: ["hypothesis_lock"] },
      }),
      ...(activeHypothesis
        ? [ledgerRecord("decision", "active_hypothesis", truncateForLedger(activeHypothesis.summary, 220), "current", turn, {
            reason: "kept active after drift violation",
            evidence: { source: "assistant" },
          })]
        : []),
    ],
  })
}

export function recordRunIntentState(context: ContextManagerLike, prompt: string) {
  const normalized = compactLine(prompt)
  if (!normalized) return
  const turn = context.state.messages.length
  context.updateLedger({
    current: [
      ledgerRecord("intent", "current_user_input", truncateForLedger(normalized, 600), "current", turn, { evidence: { source: "user", messageIndex: Math.max(0, turn - 1) } }),
      ledgerRecord("intent", "current_user_request", truncateForLedger(normalized, 240), "current", turn, { evidence: { source: "user", messageIndex: Math.max(0, turn - 1) } }),
      ledgerRecord("constraint", "main_objective", "complete latest request end-to-end; do not shrink scope unless user changes it.", "current", turn),
      ledgerRecord("constraint", "efficient_tool_usage", "do not repeatedly call read or search on the same path/query; reuse previous results and trust your findings.", "current", turn),
      ledgerRecord("constraint", "failure_recovery_rule", "after tool failure, keep objective and take nearest safe recovery.", "current", turn),
      ledgerRecord("constraint", "full_scope_finality", "do not treat probes, subsets, or dry runs as final for full-scope requests.", "current", turn),
      ledgerRecord("constraint", "evidence_grounding", "do not claim evidence unless it is in messages, summary, ledger, files, or tool outputs.", "current", turn),
      ledgerRecord("constraint", "hypothesis_lock", "once a concrete diagnosis or change hypothesis is formed, keep it until new user or tool evidence justifies changing it.", "current", turn),
    ],
  })
}

export function recordActiveSkillState(
  context: ContextManagerLike,
  selectedSkills: SkillInfo[],
  pendingSkillLoads: string[],
) {
  const turn = context.state.messages.length
  const activeSkills = selectedSkills.map((skill) => skill.name)
  const pending = normalizeCapabilityItems(pendingSkillLoads)
  const current = [
    ledgerRecord("checkpoint", "active_skills", formatCapabilityValue(activeSkills), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["skills", "capabilities"] },
    }),
    ledgerRecord("checkpoint", "pending_skill_loads", formatCapabilityValue(pending), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["skills", "capabilities"] },
    }),
    ledgerRecord("checkpoint", "active_capability_surface", capabilitySurface({
      skills: activeSkills,
      pendingSkillLoads: pending,
      mcpServers: currentCapabilityItems(context, "active_mcp_servers"),
      mcpResources: currentCapabilityItems(context, "active_mcp_resources"),
      connectors: currentCapabilityItems(context, "active_connectors"),
      webSearchEngines: currentCapabilityItems(context, "active_web_search_engine"),
    }), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["capabilities", "summary_compaction"] },
    }),
  ]
  context.updateLedger({ current })
}

export function recordCapabilityUsageState(
  context: ContextManagerLike,
  input: {
    mcpServers?: string[]
    mcpResources?: string[]
    connectors?: string[]
    webSearchEngines?: string[]
  },
) {
  const turn = context.state.messages.length
  const mcpServers = mergeCapabilityItems(currentCapabilityItems(context, "active_mcp_servers"), input.mcpServers)
  const mcpResources = mergeCapabilityItems(currentCapabilityItems(context, "active_mcp_resources"), input.mcpResources)
  const connectors = mergeCapabilityItems(currentCapabilityItems(context, "active_connectors"), input.connectors)
  const webSearchEngines = mergeCapabilityItems(currentCapabilityItems(context, "active_web_search_engine"), input.webSearchEngines)
  const skills = currentCapabilityItems(context, "active_skills")
  const pendingSkillLoads = currentCapabilityItems(context, "pending_skill_loads")
  const current = [
    ledgerRecord("checkpoint", "active_mcp_servers", formatCapabilityValue(mcpServers), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["mcp", "capabilities"] },
    }),
    ledgerRecord("checkpoint", "active_mcp_resources", formatCapabilityValue(mcpResources), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["mcp", "capabilities"] },
    }),
    ledgerRecord("checkpoint", "active_connectors", formatCapabilityValue(connectors), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["connector", "capabilities"] },
    }),
    ledgerRecord("checkpoint", "active_web_search_engine", formatCapabilityValue(webSearchEngines), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["web_search", "capabilities"] },
    }),
    ledgerRecord("checkpoint", "active_capability_surface", capabilitySurface({
      skills,
      pendingSkillLoads,
      mcpServers,
      mcpResources,
      connectors,
      webSearchEngines,
    }), "current", turn, {
      evidence: { source: "assistant" },
      scope: { topics: ["capabilities", "summary_compaction"] },
    }),
  ]
  context.updateLedger({ current })
}

export function hypothesisCorrectionMessage(violation: HypothesisViolation, activeHypothesis: ActiveHypothesis | undefined) {
  const active = activeHypothesis ? `Current active hypothesis: "${activeHypothesis.summary}".` : "No replacement hypothesis is allowed without new evidence."
  return [
    "Hypothesis discipline violation detected.",
    violation.message,
    active,
    "Return one concrete hypothesis only.",
    "If you need to change it, first cite the new user or tool evidence that justifies the change.",
  ].join("\n")
}

function currentCapabilityItems(context: ContextManagerLike, subject: string) {
  const value = context.state.ledger?.current.find((record) => record.subject === subject)?.value
  return normalizeCapabilityItems((value ?? "").split(","))
}

function mergeCapabilityItems(current: string[], next: string[] | undefined) {
  return normalizeCapabilityItems([...current, ...(next ?? [])])
}

function capabilitySurface(input: {
  skills: string[]
  pendingSkillLoads: string[]
  mcpServers: string[]
  mcpResources: string[]
  connectors: string[]
  webSearchEngines: string[]
}) {
  return [
    `skills=${formatCapabilityValue(input.skills)}`,
    `pending_skill_loads=${formatCapabilityValue(input.pendingSkillLoads)}`,
    `mcp_servers=${formatCapabilityValue(input.mcpServers)}`,
    `mcp_resources=${formatCapabilityValue(input.mcpResources)}`,
    `connectors=${formatCapabilityValue(input.connectors)}`,
    `web_search=${formatCapabilityValue(input.webSearchEngines)}`,
    "plugins=none (EasyCode v1 runtime)",
  ].join("; ")
}

function formatCapabilityValue(items: string[]) {
  return items.length > 0 ? items.join(", ") : "none"
}

function normalizeCapabilityItems(items: string[]) {
  return [...new Set(items.map((item) => compactLine(item)).filter((item) => item.length > 0 && item.toLowerCase() !== "none"))].sort((left, right) => left.localeCompare(right))
}
