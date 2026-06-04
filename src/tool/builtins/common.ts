import { z } from "zod"
import type { JsonSchema } from "../registry"

export function objectSchema(properties: JsonSchema["properties"], required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

export const SkillInput = z.object({ name: z.string() })
export const PlanExitInput = z.object({ markdown: z.string() })
export const LedgerInput = z.object({ query: z.string().optional() })
export const MemoryQueryInput = z.object({ query: z.string(), maxResults: z.number().nullish().transform((value) => value ?? 5) })
export const MemoryAddInput = z.object({ text: z.string(), tags: z.array(z.string()).nullish().transform((value) => value ?? []) })
export const ConnectorListInput = z.object({})
export const ConnectorCallInput = z.object({ name: z.string() })
export const McpListResourcesInput = z.object({ query: z.string().optional(), limit: z.number().nullish().transform((value) => value ?? 10) })
export const McpReadResourceInput = z.object({ uri: z.string(), server: z.string().optional() })
export const WebSearchInput = z.object({ query: z.string(), limit: z.number().nullish().transform((value) => value ?? 5), engine: z.string().optional(), live: z.boolean().optional() })
