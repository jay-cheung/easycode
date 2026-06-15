import path from "node:path"
import { createID, type ToolCall } from "../../message"
import { createRunAspect } from "../../instrumentation"
import { createLogger, type Logger } from "../../logger"
import type { Provider } from "../../provider"
import type { SkillArtifact } from "../../skill"
import type { ProjectMemoryRecord } from "../../memory"
import type { SubagentTaskPacket } from "../subagent-runtime"
import { maxAutoSkillArtifactInspections, autoInspectFileExtensions, autoInspectFileBasenames, autoInspectIgnoredBasenames, autoInspectIgnoredDirectories } from "./constants"

const maxPriorSubagentResultsInPrompt = 3
const maxPriorSubagentResultChars = 240

export function createSubagentLogger(root: string, sessionId: string | undefined, logger: Logger | undefined) {
  if (!logger) return undefined
  if (!logger.filePath || !logger.transcriptFilePath) return logger
  return createLogger({ root, session: `${sessionId ?? "default"}.subagents` })
}

export function withSubagentLogContext(
  provider: Provider,
  logger: Logger | undefined,
  input: { requestId: number; role: SubagentTaskPacket["role"]; task: string },
) {
  if (!logger) return provider
  const contextualLogger = ((event) => {
    const detail = event.detail && typeof event.detail === "object" ? event.detail : undefined
    logger({
      ...event,
      detail: {
        ...(detail ?? {}),
        subagentRequestId: input.requestId,
        subagentRole: input.role,
        subagentTask: input.task,
      },
    })
  }) as Logger
  contextualLogger.filePath = logger.filePath
  contextualLogger.transcriptFilePath = logger.transcriptFilePath
  return createRunAspect(contextualLogger).instrumentProvider(provider)
}

export function buildSubagentTaskPrompt(request: SubagentTaskPacket, ledgerText: string, summary: string | undefined, priorSubagentResults: string[] = []) {
  const compactPriorResults = priorSubagentResults
    .slice(-maxPriorSubagentResultsInPrompt)
    .map((result, index) => `${index + 1}. ${compactForPrompt(result, maxPriorSubagentResultChars)}`)
  const stableSections = [
    `Role: ${request.role}`,
    roleContract(request.role),
    "Execution Contract:\nUse the allowed tools internally, but return only a coordinator-facing conclusion. Prefer completing the task in this single delegation. Do not ask for follow-up unless the task is under-specified or blocked by permissions.",
    "Output Contract:\nReturn a concise structured summary with: status, summary, findings, evidenceRefs, artifacts, nextAction. evidenceRefs must be short file/command/symbol/log references, not full tool logs.",
    "Do not answer the user directly. Do not repeat the full prompt. Do not include generic process narration.",
  ]
  const dynamicSections = [
    `Task:\n${request.task}`,
    request.successCriteria ? `Success Criteria:\n${request.successCriteria}` : "",
    `Execution Budget:\nUse at most ${request.maxProviderCalls} model turns.`,
    request.assignedStep ? `Assigned Plan Step:\n${request.assignedStep.stepId}: ${request.assignedStep.goal}${request.assignedStep.doneWhen ? `\nDone When: ${request.assignedStep.doneWhen}` : ""}` : "",
    compactPriorResults.length > 0 ? `Prior Subagent Conclusions In This Run:\n${compactPriorResults.join("\n")}` : "",
    ledgerText ? `Relevant Ledger:\n${compactForPrompt(ledgerText, 1200)}` : "",
    summary ? `Conversation Summary:\n${compactForPrompt(summary, 900)}` : "",
  ].filter(Boolean)
  return [...stableSections, ...dynamicSections].join("\n\n")
}

function roleContract(role: SubagentTaskPacket["role"]) {
  switch (role) {
    case "summary":
      return "Role Contract:\nCompress context aggressively. Preserve only decisions, constraints, current state, files, commands, and unresolved blockers."
    case "explorer":
      return "Role Contract:\nFind facts quickly with read/search tools. Return exact files, symbols, and evidence snippets. Do not propose code changes unless asked."
    case "reviewer":
      return "Role Contract:\nReview for concrete bugs, regressions, missing tests, and risk. Lead with findings and file references."
    case "debugger":
      return "Role Contract:\nDiagnose failures using bounded read/search and allowed verification commands. Return root cause, evidence, and minimal recovery."
    case "tester":
      return "Role Contract:\nRun or design bounded verification. Return commands, pass/fail status, and the smallest failing signal."
    case "docs_researcher":
      return "Role Contract:\nResearch external or MCP-backed docs. Return source-backed facts and links/paths. Avoid broad summaries."
  }
}

function compactForPrompt(text: string, maxChars: number) {
  const compact = text.replace(/\s+/g, " ").trim()
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, Math.max(0, maxChars - 20)).trim()}... [truncated]`
}

export function autoSkillArtifactCalls(value: unknown, root: string): ToolCall[] {
  if (!Array.isArray(value)) return []
  const normalizedArtifacts = value
    .map((artifact) => normalizeSkillArtifact(artifact, root))
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
  const prioritizedArtifacts = [
    ...normalizedArtifacts.filter((artifact) => artifact.kind === "file" && shouldAutoInspectFile(artifact.projectPath)),
    ...normalizedArtifacts.filter((artifact) => artifact.kind === "directory" && shouldAutoInspectDirectory(artifact.projectPath)),
  ]
  const calls: ToolCall[] = []
  for (const normalized of prioritizedArtifacts) {
    if (normalized.kind === "file") {
      calls.push({
        id: createID("call_skill_artifact_read"),
        name: "read",
        input: { filePath: normalized.projectPath },
      })
    } else {
      calls.push({
        id: createID("call_skill_artifact_list"),
        name: "list",
        input: { dirPath: normalized.projectPath },
      })
    }
    if (calls.length >= maxAutoSkillArtifactInspections) break
  }
  return calls
}

function normalizeSkillArtifact(value: unknown, root: string): Pick<SkillArtifact, "kind"> & { projectPath: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const resolvedPath = (value as { resolvedPath?: unknown }).resolvedPath
  const kindValue = (value as { kind?: unknown }).kind
  if (typeof resolvedPath !== "string" || (kindValue !== "file" && kindValue !== "directory")) return undefined
  const projectPath = path.relative(root, resolvedPath).replace(/\\/g, "/")
  if (!projectPath || projectPath.startsWith("../") || path.isAbsolute(projectPath)) return undefined
  return { projectPath, kind: kindValue }
}

function shouldAutoInspectFile(projectPath: string) {
  const basename = path.basename(projectPath)
  if (autoInspectIgnoredBasenames.has(basename)) return false
  if (autoInspectFileBasenames.has(basename)) return true
  return autoInspectFileExtensions.has(path.extname(projectPath).toLowerCase())
}

function shouldAutoInspectDirectory(projectPath: string) {
  const basename = path.basename(projectPath)
  return !autoInspectIgnoredDirectories.has(basename)
}

export function memoryLedgerValue(record: ProjectMemoryRecord) {
  const tags = record.tags.length > 0 ? ` tags=${record.tags.join(",")}` : ""
  return `[${record.kind}]${tags} ${record.text}`
}

export function memoryScopeToLedger(record: ProjectMemoryRecord) {
  const files = record.scope?.files
  const symbols = record.scope?.symbols
  const topics = [...(record.scope?.topics ?? []), record.kind, ...record.tags]
  return files || symbols || topics.length > 0 ? { files, symbols, topics } : undefined
}
