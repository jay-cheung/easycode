import { McpSourceService, WebFetchService, WebSearchService, formatMcpResource, formatMcpResources, formatWebFetchResult, formatWebResults, mcpCitation, webCitation, webFetchCitation } from "../../retrieval"
import { SkillInput, PlanExitInput, McpListResourcesInput, McpReadResourceInput, WebSearchInput, WebFetchInput, PlanStepCompleteInput, PlanStepFailInput, GoalCompleteInput, GoalBlockedInput, GoalSetAcceptanceInput, DelegateSubagentInput, objectSchema } from "./common"
import type { ToolRegistry } from "../registry"
import type { SkillArtifact, SkillInfo } from "../../skill"
import { intermediatePlanStepReportMaxChars, intermediatePlanStepReportMaxLines, isIntermediatePlanStepReportTooLong, loadStructuredPlanState, nextIncompletePlanStep, planStepReportLineCount } from "../../plans"
import { PlanTracker } from "../../agent/planner"
import { GoalStateError, assertGoalPhase, goalStateFromContext, writeGoalState } from "../../goal"
import type { Message } from "../../message"

function formatSkillArtifact(artifact: SkillArtifact) {
  const detail = artifact.kind === "missing" ? "missing" : artifact.kind
  return `- ${detail}: ${artifact.path}`
}

function formatSkillOutput(skill: SkillInfo) {
  const sections: string[] = []
  if (skill.artifacts && skill.artifacts.length > 0) {
    sections.push("<skill_artifacts>")
    sections.push("Inspect these referenced local artifacts before inventing a new workflow:")
    sections.push(...skill.artifacts.map(formatSkillArtifact))
    sections.push("</skill_artifacts>")
    sections.push("")
  }
  if (skill.content?.trim()) sections.push(skill.content.trim())
  return sections.join("\n").trim()
}

export function registerRetrievalTools(registry: ToolRegistry) {
  registry.register({
    name: "mcp_list_resources",
    description: "List configured MCP-style resources from .easycode/mcp.json. Use before mcp_read_resource when source uri is unknown.",
    inputSchema: McpListResourcesInput,
    jsonSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" } }, []),
    permission: "mcp",
    modes: ["build", "plan"],
    patterns: () => [".easycode/mcp.json"],
    execute: async (input, ctx) => {
      const startedAt = Date.now()
      const params = McpListResourcesInput.parse(input)
      const resources = await new McpSourceService(ctx.sandbox.root).listResources(params.query, params.limit)
      return {
        title: "MCP resources",
        output: formatMcpResources(resources),
        metadata: { status: "succeeded", query: params.query, count: resources.length, elapsedMs: Date.now() - startedAt, sources: resources.map(mcpCitation) },
      }
    },
  })

  registry.register({
    name: "mcp_read_resource",
    description: "Read one configured MCP-style resource by URI with structured citation metadata.",
    inputSchema: McpReadResourceInput,
    jsonSchema: objectSchema({ uri: { type: "string" }, server: { type: "string" } }, ["uri"]),
    permission: "mcp",
    modes: ["build", "plan"],
    patterns: (input) => {
      const params = McpReadResourceInput.parse(input)
      return [`.easycode/mcp.json`, `mcp:${params.server ?? "*"}:${params.uri}`]
    },
    execute: async (input, ctx) => {
      const startedAt = Date.now()
      const params = McpReadResourceInput.parse(input)
      const resource = await new McpSourceService(ctx.sandbox.root).readResource(params.uri, params.server)
      if (!resource) return { title: "MCP resource", output: `MCP resource not found: ${params.uri}`, metadata: { status: "failed", uri: params.uri } }
      const citation = mcpCitation(resource)
      return {
        title: resource.title,
        output: formatMcpResource(resource),
        metadata: { status: "succeeded", elapsedMs: Date.now() - startedAt, source: citation, sources: [citation] },
      }
    },
  })

  registry.register({
    name: "web_search",
    description: "Search web evidence. Uses Tavily live search when configured in .easycode/websearch.json or via TAVILY_API_KEY, otherwise searches fixture results.",
    inputSchema: WebSearchInput,
    jsonSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" }, engine: { type: "string" }, live: { type: "boolean" } }, ["query"]),
    permission: "web_search",
    modes: ["build", "plan"],
    patterns: (input) => [`web:${WebSearchInput.parse(input).query}`],
    execute: async (input, ctx) => {
      const startedAt = Date.now()
      const params = WebSearchInput.parse(input)
      const response = await new WebSearchService(ctx.sandbox.root).search(params.query, params.limit, { engine: params.engine, live: params.live, signal: ctx.signal })
      return {
        title: params.query,
        output: formatWebResults(response.results),
        metadata: {
          status: "succeeded",
          query: params.query,
          engine: response.engine,
          count: response.results.length,
          elapsedMs: Date.now() - startedAt,
          sources: response.results.map(webCitation),
          resultsPreview: response.results.slice(0, 5),
          live: response.live,
          warning: response.warning,
        },
      }
    },
  })

  registry.register({
    name: "web_fetch",
    description: "Fetch one HTTP/HTTPS URL with bounded output. Use instead of bash curl for readonly web requests. Supports GET/HEAD, safe headers, redirects, retries, TLS override, and structured citations.",
    inputSchema: WebFetchInput,
    jsonSchema: objectSchema({
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "HEAD"] },
      headers: { type: "object", additionalProperties: { type: "string" } },
      followRedirects: { type: "boolean" },
      includeHeaders: { type: "boolean" },
      insecureTLS: { type: "boolean" },
      timeoutMs: { type: "number" },
      maxBytes: { type: "number" },
      retries: { type: "number" },
      retryDelayMs: { type: "number" },
    }, ["url"]),
    permission: "web_fetch",
    modes: ["build", "plan"],
    patterns: (input) => [`web_fetch:${WebFetchInput.parse(input).url}`],
    execute: async (input, ctx) => {
      const startedAt = Date.now()
      const params = WebFetchInput.parse(input)
      const result = await new WebFetchService().fetch(params, { signal: ctx.signal })
      const citation = webFetchCitation(result)
      return {
        title: result.title,
        output: formatWebFetchResult(result),
        metadata: {
          status: result.ok ? "succeeded" : "failed",
          method: result.method,
          url: result.url,
          finalUrl: result.finalUrl,
          httpStatus: result.status,
          statusText: result.statusText,
          contentType: result.contentType,
          contentLength: result.contentLength,
          bytesRead: result.bytesRead,
          truncated: result.truncated,
          redirected: result.redirected,
          elapsedMs: Date.now() - startedAt,
          source: citation,
          sources: [citation],
        },
      }
    },
  })

  registry.register({
    name: "skill",
    description: "Load the full content of a named skill.",
    inputSchema: SkillInput,
    jsonSchema: objectSchema({ name: { type: "string" } }),
    permission: "skill",
    modes: ["build", "plan"],
    patterns: (input) => [SkillInput.parse(input).name],
    execute: async (input, ctx) => {
      const params = SkillInput.parse(input)
      const skill = await ctx.skills.load(params.name)
      if (!skill) return { title: params.name, output: `Skill not found: ${params.name}`, metadata: { status: "failed" } }
      return {
        title: `Loaded skill: ${skill.name}`,
        output: formatSkillOutput(skill),
        metadata: {
          status: "succeeded",
          skillName: skill.name,
          skillDescription: skill.description,
          location: skill.location,
          artifacts: skill.artifacts ?? [],
          artifactCount: skill.artifacts?.length ?? 0,
        },
      }
    },
  })

  registry.register({
    name: "delegate_subagent",
    description: "Coordinator-only internal action. Delegate a bounded internal task to a subagent role and consume its structured result in the next model turn. Prefer this over direct repo/search/read/bash tools when the work is pure fact-finding, review, debugging, testing, or docs research. USE THIS FOR: finding all X in codebase (explorer), reviewing a file/plan (reviewer), debugging a test failure (debugger), running tests (tester), researching docs (docs_researcher), summarizing history (summary). Do NOT delegate: write operations, or work that depends on session history.",
    inputSchema: DelegateSubagentInput,
    jsonSchema: objectSchema({
      role: { type: "string", enum: ["summary", "explorer", "reviewer", "debugger", "tester", "docs_researcher"] },
      task: { type: "string" },
      success_criteria: { type: "string" },
    }, ["role", "task"]),
    permission: "delegate_subagent",
    modes: ["build"],
    patterns: () => ["*"],
    execute: async () => ({
      title: "delegate_subagent",
      output: "delegate_subagent must be intercepted by the runner before reaching the tool registry.",
      metadata: { status: "failed", error: "internal_action_not_intercepted" },
    }),
  })

  registry.register({
    name: "plan_exit",
    description: "Finish the current turn with a final recommended markdown plan when the task should pause for user approval before implementation continues.",
    inputSchema: PlanExitInput,
    jsonSchema: objectSchema({ markdown: { type: "string" } }),
    permission: "plan_exit",
    modes: ["build", "plan"],
    patterns: () => ["*"],
    execute: async (input) => {
      const params = PlanExitInput.parse(input)
      return { title: "Plan", output: `<proposed_plan>\n${params.markdown.trim()}\n</proposed_plan>`, metadata: { status: "succeeded" } }
    },
  })

  registry.register({
    name: "plan_step_complete",
    description: "Mark the current active plan step as completed with a required progress report and advance to the next step.",
    inputSchema: PlanStepCompleteInput,
    jsonSchema: objectSchema({ message: { type: "string" }, report: { type: "string" } }, ["report"]),
    permission: "plan_step_complete",
    modes: ["build"],
    patterns: () => ["*"],
    execute: async (input, ctx) => {
      const params = PlanStepCompleteInput.parse(input)
      if (!ctx.context) return { title: "Error", output: "Context manager missing.", metadata: { status: "failed" } }
      const ledger = ctx.context.state.ledger
      const planIdRecord = ledger?.current.find(r => r.subject === "current_plan_id" && r.status === "current")
      if (!planIdRecord) return { title: "Error", output: "No active plan found.", metadata: { status: "failed" } }
      
      const planId = planIdRecord.value
      const currentStepRecord = ledger?.current.find(r => r.subject === "current_plan_step" && r.status === "current")
      if (!currentStepRecord) return { title: "Error", output: "No active step found.", metadata: { status: "failed" } }
      
      const currentStepId = currentStepRecord.value
      const sessionIdRecord = ledger?.current.find(r => r.subject === "current_session_id" && r.status === "current")
      const sessionId = sessionIdRecord?.value ?? "default"
      
      const state = await loadStructuredPlanState(ctx.sandbox.root, sessionId, planId)
      if (!state) return { title: "Error", output: `Could not load structured plan ${planId}.`, metadata: { status: "failed" } }
      const { plan, checkpoint } = state
      const stepStatuses = { ...checkpoint.stepStatuses, [currentStepId]: "completed" as const }
      const nextStep = nextIncompletePlanStep(plan, stepStatuses)
      const report = params.report.trim()
      if (nextStep && isIntermediatePlanStepReportTooLong(report)) {
        return {
          title: "Plan Step Completed",
          output: `Intermediate plan steps require a concise progress report. Keep report within ${intermediatePlanStepReportMaxChars} characters and ${intermediatePlanStepReportMaxLines} lines; reserve longer reports for the final step.`,
          metadata: {
            status: "failed",
            error: "plan_step_report_too_long_before_final_step",
            maxChars: intermediatePlanStepReportMaxChars,
            maxLines: intermediatePlanStepReportMaxLines,
            reportChars: report.length,
            reportLines: planStepReportLineCount(report),
          },
        }
      }
      
      if (nextStep) {
        await PlanTracker.activatePlan(ctx.context, ctx.sandbox.root, sessionId, plan, {
          currentStepId: nextStep.id,
          stepStatuses: { ...stepStatuses, [nextStep.id]: "running" },
          status: "running",
        })
        return {
          title: "Plan Step Completed",
          output: [
            `Step ${currentStepId} completed successfully.`,
            params.message?.trim() ? `Completion summary: ${params.message.trim()}` : "",
            `Report:\n${report}`,
            `Proceeding to Step ${nextStep.id}: ${nextStep.goal}. Continue immediately with that step and do not ask the user whether to continue.`,
          ].filter(Boolean).join("\n"),
          metadata: { status: "succeeded", nextStepId: nextStep.id, report, message: params.message?.trim() }
        }
      } else {
        await PlanTracker.activatePlan(ctx.context, ctx.sandbox.root, sessionId, plan, {
          currentStepId: undefined,
          stepStatuses,
          status: "completed",
        })
        await PlanTracker.clearActivePlan(ctx.context, ctx.sandbox.root, planId)
        
        return {
          title: "Plan Completed",
          output: report,
          metadata: { status: "succeeded", planCompleted: true, report, message: params.message?.trim() }
        }
      }
    }
  })

  registry.register({
    name: "plan_step_fail",
    description: "Mark the current active plan step as failed and request a replan when the step cannot be completed safely.",
    inputSchema: PlanStepFailInput,
    jsonSchema: objectSchema({ reason: { type: "string" } }, ["reason"]),
    permission: "plan_step_fail",
    modes: ["build"],
    patterns: () => ["*"],
    execute: async (input, ctx) => {
      const params = PlanStepFailInput.parse(input)
      if (!ctx.context) return { title: "Error", output: "Context manager missing.", metadata: { status: "failed" } }
      const ledger = ctx.context.state.ledger
      const planIdRecord = ledger?.current.find(r => r.subject === "current_plan_id" && r.status === "current")
      if (!planIdRecord) return { title: "Error", output: "No active plan found.", metadata: { status: "failed" } }
      
      const currentStepRecord = ledger?.current.find(r => r.subject === "current_plan_step" && r.status === "current")
      if (!currentStepRecord) return { title: "Error", output: "No active step found.", metadata: { status: "failed" } }
      
      const currentStepId = currentStepRecord.value
      
      return {
        title: "Plan Step Failed",
        output: `Step ${currentStepId} failed: ${params.reason}. Replanning is being triggered...`,
        metadata: { status: "failed", failedStepId: currentStepId, reason: params.reason }
      }
    }
  })

  registry.register({
    name: "goal_set_acceptance",
    description: "Record the goal acceptance criteria and completion checks that must be satisfied before the goal can be completed.",
    inputSchema: GoalSetAcceptanceInput,
    jsonSchema: objectSchema({
      acceptanceCriteria: { type: "array", items: { type: "string" } },
      completionChecks: { type: "array", items: { type: "string" } },
    }, ["acceptanceCriteria", "completionChecks"]),
    permission: "goal_set_acceptance",
    modes: ["build"],
    patterns: () => ["*"],
    execute: async (input, ctx) => {
      const params = GoalSetAcceptanceInput.parse(input)
      if (!ctx.context) return { title: "Goal Acceptance Recorded", output: "Context manager missing.", metadata: { status: "failed", error: "context_missing" } }
      let goal
      try {
        goal = assertGoalPhase(goalStateFromContext(ctx.context), "goal_set_acceptance", ["defining"])
      } catch (error) {
        if (error instanceof GoalStateError) {
          return {
            title: "Goal Acceptance Recorded",
            output: error.message,
            metadata: { status: "failed", error: "goal_acceptance_wrong_phase" },
          }
        }
        return {
          title: "Goal Acceptance Recorded",
          output: String(error),
          metadata: { status: "failed", error: "goal_acceptance_wrong_phase" },
        }
      }
      writeGoalState(ctx.context, {
        ...goal,
        status: "planning",
        acceptanceCriteria: params.acceptanceCriteria.map((item) => item.trim()).filter(Boolean),
        completionChecks: params.completionChecks.map((item) => item.trim()).filter(Boolean),
        blocker: undefined,
        updatedAt: Date.now(),
      })
      return {
        title: "Goal Acceptance Recorded",
        output: [
          "Acceptance criteria:",
          ...params.acceptanceCriteria.map((item) => `- ${item}`),
          "Completion checks:",
          ...params.completionChecks.map((item) => `- ${item}`),
        ].join("\n"),
        metadata: {
          status: "succeeded",
          acceptanceCriteria: params.acceptanceCriteria,
          completionChecks: params.completionChecks,
        },
      }
    },
  })

  registry.register({
    name: "goal_complete",
    description: "Mark the current goal as fully satisfied and stop automatic continuation.",
    inputSchema: GoalCompleteInput,
    jsonSchema: objectSchema({ summary: { type: "string" } }, ["summary"]),
    permission: "goal_complete",
    modes: ["build"],
    patterns: () => ["*"],
    execute: async (input, ctx) => {
      const params = GoalCompleteInput.parse(input)
      if (ctx.context) {
        const goal = goalStateFromContext(ctx.context)
        if (goal) {
          if (goal.acceptanceCriteria.length === 0 || goal.completionChecks.length === 0) {
            return {
              title: "Goal Completed",
              output: "Goal acceptance criteria have not been recorded yet.",
              metadata: { status: "failed", error: "goal_acceptance_missing" },
            }
          }
          const planId = ctx.context.state.ledger?.current.find((record) => record.subject === "current_plan_id" && record.status === "current")?.value
          if (goal.status === "executing" || planId) {
            return {
              title: "Goal Completed",
              output: "The active plan slice must finish and be reviewed before the goal can be completed.",
              metadata: { status: "failed", error: "goal_review_required", goalStatus: goal.status, activePlanId: planId },
            }
          }
          if (goal.status === "reviewing") {
            const latestAssistantText = latestAssistantTextFromMessages(ctx.context.state.messages)
            if (reviewCompletionHasBlockingSignals(params.summary, latestAssistantText)) {
              return {
                title: "Goal Completed",
                output: "Goal review still reports blocking defects or gaps. Use plan_exit for the next bounded fix/review slice instead of goal_complete.",
                metadata: { status: "failed", error: "goal_review_blocking_findings", goalStatus: goal.status },
              }
            }
          }
          writeGoalState(ctx.context, { ...goal, status: "completed", blocker: undefined, summary: params.summary, updatedAt: Date.now() })
          if (planId) await PlanTracker.clearActivePlan(ctx.context, ctx.sandbox.root, planId)
        }
      }
      return {
        title: "Goal Completed",
        output: params.summary,
        metadata: { status: "succeeded", goalStatus: "completed", summary: params.summary },
      }
    },
  })

  registry.register({
    name: "goal_blocked",
    description: "Mark the current goal as blocked because safe progress now requires user input or a denied high-risk action.",
    inputSchema: GoalBlockedInput,
    jsonSchema: objectSchema({ reason: { type: "string" } }, ["reason"]),
    permission: "goal_blocked",
    modes: ["build"],
    patterns: () => ["*"],
    execute: async (input, ctx) => {
      const params = GoalBlockedInput.parse(input)
      if (ctx.context) {
        const goal = goalStateFromContext(ctx.context)
        if (goal) {
          writeGoalState(ctx.context, { ...goal, status: "blocked", blocker: params.reason, updatedAt: Date.now() })
          const planId = ctx.context.state.ledger?.current.find((record) => record.subject === "current_plan_id" && record.status === "current")?.value
          if (planId) await PlanTracker.clearActivePlan(ctx.context, ctx.sandbox.root, planId)
        }
      }
      return {
        title: "Goal Blocked",
        output: params.reason,
        metadata: { status: "succeeded", goalStatus: "blocked", reason: params.reason },
      }
    },
  })
}

function latestAssistantTextFromMessages(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const text = message.parts
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

function reviewCompletionHasBlockingSignals(summary: string, latestAssistantText: string) {
  const combined = [summary, latestAssistantText].filter(Boolean).join("\n").toLowerCase()
  if (!combined) return false
  const cleanPassPatterns = [
    /\bno remaining (blocker|blockers|defect|defects|gap|gaps|critical issue|critical issues)\b/,
    /\ball blockers resolved\b/,
    /\bready to commit\b/,
    /\bready for commit\b/,
    /未发现阻塞/,
    /无阻塞/,
    /所有阻塞(已)?解决/,
    /可以提交/,
    /可提交/,
  ]
  if (cleanPassPatterns.some((pattern) => pattern.test(combined))) return false
  const blockerPatterns = [
    /\bnot committable\b/,
    /\bmust be fixed\b/,
    /\bblocking defects?\b/,
    /\bblockers?\b/,
    /\bcritical issues?\b/,
    /\bremaining defects?\b/,
    /\bfix(es)? first\b/,
    /不可提交/,
    /必须修复/,
    /阻塞/,
    /关键问题/,
    /严重问题/,
    /缺陷/,
  ]
  return blockerPatterns.some((pattern) => pattern.test(combined))
}
