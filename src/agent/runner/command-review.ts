import type { PermissionAutoReviewer, PermissionRequest, PermissionReply } from "../../permission"
import type { Provider } from "../../provider"
import { emitLog, type Logger } from "../../logger"

type CommandReviewDecision = {
  decision: "allow_once" | "reject" | "ask_user"
  reason?: string
}

export function createCommandReviewAutoReviewer(provider: Provider, logger?: Logger): PermissionAutoReviewer {
  return async (request) => {
    if (!isCommandReviewRequest(request)) return undefined
    const review = await runCommandReviewSubagent(provider, request, logger)
    if (!review) return undefined
    if (review.decision === "allow_once") return "once"
    if (review.decision === "reject") return "reject"
    return undefined
  }
}

function isCommandReviewRequest(request: PermissionRequest) {
  return request.permission === "bash" && request.metadata.bashSafetyAction === "review"
}

async function runCommandReviewSubagent(provider: Provider, request: PermissionRequest, logger?: Logger): Promise<CommandReviewDecision | undefined> {
  const command = typeof request.metadata.command === "string" ? request.metadata.command : request.patterns.join(", ")
  const cwd = typeof request.metadata.cwd === "string" ? request.metadata.cwd : undefined
  const riskTags = Array.isArray(request.metadata.bashSafetyRiskTags) ? request.metadata.bashSafetyRiskTags.filter((item): item is string => typeof item === "string") : []
  const prompt = [
    "You are EasyCode's command-review subagent.",
    "Review this bash permission request. You cannot call tools. Return only JSON with decision and reason.",
    "Allowed decisions: allow_once, reject, ask_user.",
    "Reject destructive commands, git remote operations, credential exposure, or clear host/environment escape.",
    "Ask the user when intent or blast radius is ambiguous.",
    "Allow once only when the command is useful, bounded to the project or allowed scratch paths, and the risk tags are acceptable.",
    JSON.stringify({ command, cwd, patterns: request.patterns, riskTags, reason: request.metadata.bashSafetyReason }, null, 2),
  ].join("\n")
  let text = ""
  try {
    for await (const event of provider.stream({
      mode: "build",
      prompt,
      messages: [],
      providerMessages: [
        { role: "system", content: "You are a narrow command-review subagent. Return strict JSON only." },
        { role: "user", content: prompt },
      ],
      tools: [],
    })) {
      if (event.type === "text_delta") text += event.text
      if (event.type === "failure") {
        emitLog(logger, { type: "state", name: "command_review.failed", detail: { command, output: event.error.output || event.error.message } })
        return undefined
      }
    }
  } catch (error) {
    emitLog(logger, { type: "state", name: "command_review.error", detail: { command, error: error instanceof Error ? error.message : String(error) } })
    return undefined
  }
  const parsed = parseCommandReviewDecision(text)
  emitLog(logger, { type: "state", name: "command_review.decision", detail: { command, decision: parsed?.decision ?? "unparsed", reason: parsed?.reason } })
  return parsed
}

function parseCommandReviewDecision(text: string): CommandReviewDecision | undefined {
  const trimmed = text.trim()
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.match(/\{[\s\S]*\}/)?.[0],
  ].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (!value || typeof value !== "object") continue
      const decision = (value as { decision?: unknown }).decision
      if (decision !== "allow_once" && decision !== "reject" && decision !== "ask_user") continue
      const reason = (value as { reason?: unknown }).reason
      return { decision, reason: typeof reason === "string" ? reason : undefined }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}
