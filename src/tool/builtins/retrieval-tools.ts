import { McpSourceService, WebSearchService, formatMcpResource, formatMcpResources, formatWebResults, mcpCitation, webCitation } from "../../retrieval"
import { SkillInput, PlanExitInput, McpListResourcesInput, McpReadResourceInput, WebSearchInput, PlanStepCompleteInput, PlanStepFailInput, objectSchema } from "./common"
import type { ToolRegistry } from "../registry"
import type { SkillArtifact, SkillInfo } from "../../skill"
import { loadStructuredPlanState, nextIncompletePlanStep } from "../../plans"
import { PlanTracker } from "../../agent/planner"

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
    description: "Mark the current active plan step as completed and advance to the next step.",
    inputSchema: PlanStepCompleteInput,
    jsonSchema: objectSchema({ message: { type: "string" } }, []),
    permission: "plan_step_complete",
    modes: ["build"],
    patterns: () => ["*"],
    execute: async (input, ctx) => {
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
      
      if (nextStep) {
        await PlanTracker.activatePlan(ctx.context, ctx.sandbox.root, sessionId, plan, {
          currentStepId: nextStep.id,
          stepStatuses: { ...stepStatuses, [nextStep.id]: "running" },
          status: "running",
        })
        return {
          title: "Plan Step Completed",
          output: `Step ${currentStepId} completed successfully. Proceeding to Step ${nextStep.id}: ${nextStep.goal}`,
          metadata: { status: "succeeded", nextStepId: nextStep.id }
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
          output: `All steps in plan ${plan.title || planId} completed successfully!`,
          metadata: { status: "succeeded", planCompleted: true }
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
}
