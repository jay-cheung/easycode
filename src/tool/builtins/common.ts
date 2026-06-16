import { z } from "zod"
import type { JsonSchema } from "../registry"

export function objectSchema(properties: JsonSchema["properties"], required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

export const SkillInput = z.object({ name: z.string() })
export const PlanExitInput = z.object({ markdown: z.string() })
export const LedgerInput = z.object({ query: z.string().optional() })
export const MemoryQueryInput = z.object({ query: z.string(), maxResults: z.number().nullish().transform((value) => value ?? 5) })
export const MemoryAddInput = z.object({
  text: z.string(),
  kind: z.enum(["note", "session_archive", "preference", "repo_fact", "failure_pattern", "successful_workflow"]).nullish().transform((value) => value ?? "note"),
  tags: z.array(z.string()).nullish().transform((value) => value ?? []),
  scope: z.object({
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
  }).optional(),
})
export const MemoryPromoteInput = z.object({
  text: z.string(),
  kind: z.enum(["preference", "repo_fact", "failure_pattern", "successful_workflow"]),
  tags: z.array(z.string()).nullish().transform((value) => value ?? []),
  scope: z.object({
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
  }).optional(),
})
export const ConnectorListInput = z.object({})
export const ConnectorCallInput = z.object({ name: z.string() })
export const McpListResourcesInput = z.object({ query: z.string().optional(), limit: z.number().nullish().transform((value) => value ?? 10) })
export const McpReadResourceInput = z.object({ uri: z.string(), server: z.string().optional() })
export const WebSearchInput = z.object({ query: z.string(), limit: z.number().nullish().transform((value) => value ?? 5), engine: z.string().optional(), live: z.boolean().optional() })
export const WebFetchInput = z.object({
  url: z.string(),
  method: z.enum(["GET", "HEAD"]).nullish().transform((value) => value ?? "GET"),
  headers: z.record(z.string(), z.string()).nullish().transform((value) => value ?? {}),
  followRedirects: z.boolean().nullish().transform((value) => value ?? false),
  includeHeaders: z.boolean().nullish().transform((value) => value ?? false),
  insecureTLS: z.boolean().nullish().transform((value) => value ?? false),
  timeoutMs: z.number().nullish().transform((value) => value ?? 10_000),
  maxBytes: z.number().nullish().transform((value) => value ?? 24_000),
  retries: z.number().nullish().transform((value) => value ?? 0),
  retryDelayMs: z.number().nullish().transform((value) => value ?? 250),
})

export const PlanStepCompleteInput = z.object({
  message: z.string().optional(),
  report: z.string().trim().min(1),
})

export const PlanStepFailInput = z.object({
  reason: z.string(),
})

export const GoalCompleteInput = z.object({
  summary: z.string(),
})

export const GoalBlockedInput = z.object({
  reason: z.string(),
})

export const GoalSetAcceptanceInput = z.object({
  acceptanceCriteria: z.array(z.string()).min(1),
  completionChecks: z.array(z.string()).min(1),
})

export const DelegateSubagentInput = z.object({
  role: z.enum(["summary", "explorer", "reviewer", "debugger", "tester", "docs_researcher"]),
  task: z.string(),
  success_criteria: z.string().optional(),
})
