import path from "node:path"
import { createID, type ToolCall } from "../../message"
import { createRunAspect } from "../../instrumentation"
import { createLogger, type Logger } from "../../logger"
import type { Provider } from "../../provider"
import type { SkillArtifact } from "../../skill"
import type { ProjectMemoryRecord } from "../../memory"
import type { SubagentTaskPacket } from "../subagent-runtime"
import { maxAutoSkillArtifactInspections, autoInspectFileExtensions, autoInspectFileBasenames, autoInspectIgnoredBasenames, autoInspectIgnoredDirectories } from "./constants"

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

export function buildSubagentTaskPrompt(request: SubagentTaskPacket, ledgerText: string, summary: string | undefined) {
  const sections = [
    `Role: ${request.role}`,
    `Task:\n${request.task}`,
    request.successCriteria ? `Success Criteria:\n${request.successCriteria}` : "",
    `Turn Budget:\nYou have at most ${request.maxProviderCalls} model turns for this task. If you cannot fully complete the task, return a concise stage summary for the coordinator before the budget is exhausted.`,
    request.assignedStep ? `Assigned Plan Step:\n${request.assignedStep.stepId}: ${request.assignedStep.goal}${request.assignedStep.doneWhen ? `\nDone When: ${request.assignedStep.doneWhen}` : ""}` : "",
    ledgerText ? `Relevant Context Ledger:\n${ledgerText}` : "",
    summary ? `Compacted Conversation Summary:\n${summary}` : "",
    "Return only the result for the coordinator. Do not answer the user directly.",
    "If the task remains incomplete near the budget limit, stop exploring and return a stage handoff with findings, artifacts, and the next narrow follow-up.",
  ].filter(Boolean)
  return sections.join("\n\n")
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
