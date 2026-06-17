# Data Structures

```ts
type AgentMode = "build" | "plan" // "plan" is a legacy internal alias; CLI uses one unified run flow.
type PermissionAction = "deny" | "ask" | "allow"
type MessageRole = "system" | "user" | "assistant" | "tool"
type ToolCallStatus = "pending" | "running" | "succeeded" | "failed" | "denied"
type SubagentRole = "summary" | "explorer" | "reviewer" | "debugger" | "tester" | "docs_researcher"

type Agent = {
  name: string
  mode: AgentMode
  systemPrompt: string
}

type PlanStep = {
  id: string
  goal: string
  kind: "inspect" | "edit" | "verify" | "document" | "gate"
  timeoutMs?: number
  executorHint?: "main" | "subagent"
  subagentRole?: SubagentRole
  delegationPolicy?: "required" | "preferred"
  targetFiles?: string[]
  dependsOn?: string[]
  doneWhen?: string
  fallback?: string
}

type ExecutionPlan = {
  id: string
  title?: string
  steps: PlanStep[]
}

type PlanRunState = "draft" | "running" | "blocked" | "completed" | "abandoned"

type ReplanReason = "tool_failure" | "verification_failure" | "scope_change" | "new_evidence"

type PlanCheckpoint = {
  currentStepId?: string
  stepStatuses: Record<string, "pending" | "running" | "completed" | "failed" | "blocked">
  status: PlanRunState
  blocker?: string
  verificationTarget?: string
  lastReplanReason?: ReplanReason
}

type PermissionRule = {
  permission: string
  pattern: string
  action: PermissionAction
}

type ToolDef = {
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  jsonSchema: JsonSchema
  permission: string
  modes: AgentMode[]
  patterns(input: unknown, ctx: ToolContext): string[]
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

type SkillDiagnostic = {
  code: "read_failed" | "missing_required_frontmatter" | "duplicate_name"
  message: string
  location?: string
  name?: string
  ids?: string[]
}

type SubagentRequest = {
  role: SubagentRole
  task: string
  successCriteria?: string
  timeoutMs?: number
}

type SubagentTaskPacket = {
  requestId: number
  role: SubagentRole
  task: string
  successCriteria?: string
  maxProviderCalls: number
  timeoutMs?: number
  assignedStep?: {
    planId: string
    stepId: string
    goal: string
    doneWhen?: string
    timeoutMs?: number
  }
}

type Message = {
  id: string
  role: MessageRole
  parts: MessagePart[]
  createdAt: number
}

type ImagePart = {
  type: "image"
  source:
    | { type: "path"; path: string; mimeType: string }
    | { type: "url"; url: string; mimeType?: string }
}

type ReasoningPart = {
  type: "reasoning"
  text: string
}

type SessionSettings = {
  provider: string
  model?: string
  language: "en" | "zh" | "ja" | "fr" | "ko" | "de"
  thinking: boolean
  effort: "low" | "medium" | "high" | "max"
  maxTokens?: number
  maxSteps?: number
  responseReserveTokens?: number
  selectedSkills: string[]
  pendingSkillLoads: string[]
}

type SessionTokenUsage = {
  inputTokens: number
  outputTokens: number
  calls: number
  subagentInputTokens: number
  subagentOutputTokens: number
  subagentCalls: number
  subagentCacheHitTokens: number
  subagentCacheMissTokens: number
}

type SessionData = {
  version: 1
  id: string
  messages: Message[]
  summary?: string
  ledger?: StructuredContextLedger
  settings?: SessionSettings
  tokenUsage?: SessionTokenUsage
  updatedAt: number
}

type ContextState = {
  messages: Message[]
  summary?: string
  ledger?: StructuredContextLedger
  tokenEstimate: number
  maxTokens: number
}

type ProviderEvent =
  | { type: "request"; request: { url: string; method: string; body: unknown } }
  | { type: "response"; response: { url: string; status: number; ok: boolean; headers: Record<string, string>; body?: string } }
  | { type: "response_raw"; response: unknown }
  | { type: "failure"; error: { message: string; code?: string; output: string } }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number; totalTokens?: number; reasoningTokens?: number }
  | { type: "done" }

type RunUiEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; toolName: string; status: string; output: string }

type RepoMapResult = {
  root: string
  dir: string
  entries: Array<{
    filePath: string
    hash: string
    mtimeMs: number
    size: number
    symbols: Array<{ name: string; kind: string; line: number; signature?: string }>
  }>
  cache: { path: string; hit: boolean; gitIgnored: boolean }
}

type CodeIndexResult = {
  root: string
  dir: string
  files: Array<{ filePath: string; hash: string; mtimeMs: number; size: number; imports: string[]; exports: string[] }>
  symbols: Array<{ id: string; filePath: string; name: string; kind: string; startLine: number; endLine: number; signature?: string }>
  edges: Array<{ kind: "imports" | "exports" | "calls" | "references" | "inherits" | "implements"; from: string; to: string; filePath: string; line: number; preview?: string }>
  cache: { path: string; hit: boolean; gitIgnored: boolean }
}
```

## Invariants
- Tool calls and tool results are represented as message parts.
- Thinking and images are represented as message parts, not folded into final assistant text.
- Provider-facing messages are derived from internal messages.
- The structured context ledger carries durable current-state and recent-history records such as the latest direct user input, current user request, and active capability surface for compaction continuity.
- Tool metadata includes status and safety metadata where relevant.
- Zod validates model-produced tool arguments before execution.
- Runtime message factories and historical normalization reject or repair malformed message parts before provider submission.
- Session settings persist model/language/thinking/effort/skill choices; pending images do not persist.
- Session files include an explicit `version: 1`. Missing version means legacy v0 data and is migrated to v1 on load; unsupported future versions must fail closed instead of partially loading.
- Skill discovery skips invalid or unreadable skill files without blocking valid skills, and exposes diagnostics for read failures, missing required frontmatter, and duplicate names.
- Structured execution plans persist a machine-readable step list plus a checkpoint (`currentStepId`, step-status map, lifecycle status, blocker metadata) so execution can resume without replaying raw message history.
- Plan steps may carry hidden execution metadata (`executorHint`, `subagentRole`, `delegationPolicy`, `timeoutMs`). User-facing markdown renderers may show timeout but must not show hidden subagent routing hints directly.
- Subagent requests may carry a bounded wall-clock timeout; the runtime clamps it and propagates it to the provider abort signal.
- Repo map and code index caches are derived artifacts under the EasyCode project cache directory (`~/.easycode/projects/<hash>/cache/` in normal runtime, project-local `.easycode/cache/` in tests); deleting them must not affect correctness.
- Code-navigation tools preserve the public protocol while switching internals from CLI search to index-first lookup.
- `code-index/index.json` is tool-private cache data. It must never be returned wholesale to the model; model-visible navigation outputs are limited to repo-map skeletons, bounded search previews, and `read_lines` slices.

## Session Tail Persistence
- Session save persists the compacted summary plus a provider-valid recent suffix, not the full raw transcript.
- `persistedSessionMessages(messages, preserveRecentUserTurns, compactPreserveTokens)` first selects the configured number of recent user turns, then fits those turns inside the compact preserve token budget.
- `recentSessionMessageSuffix()` preserves the latest completed user/assistant turn even when it exceeds the normal preserve budget, because dropping that answer can cause a restored session to replay an already answered prompt.
- If no user turn exists, `greedySessionMessageSuffix()` walks backward from the latest message and keeps the largest provider-valid suffix that fits the budget.
- Session-tail selection must never leave orphan tool results before their matching tool calls in provider-facing history.
