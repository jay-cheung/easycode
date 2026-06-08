# Data Structures

```ts
type AgentMode = "build" | "plan"
type PermissionAction = "deny" | "ask" | "allow"
type MessageRole = "system" | "user" | "assistant" | "tool"
type ToolCallStatus = "pending" | "running" | "succeeded" | "failed" | "denied"

type Agent = {
  name: string
  mode: AgentMode
  systemPrompt: string
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
  thinking: boolean
  effort: "low" | "medium" | "high" | "max"
  selectedSkills: string[]
  pendingSkillLoads: string[]
}

type ContextState = {
  messages: Message[]
  summary?: string
  ledger?: StructuredContextLedger
  tokenEstimate: number
  maxTokens: number
}

type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
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
- Session settings persist model/language/thinking/effort/skill choices; pending images do not persist.
- Repo map and code index caches are derived artifacts under the EasyCode project cache directory (`~/.easycode/projects/<hash>/cache/` in normal runtime, project-local `.easycode/cache/` in tests); deleting them must not affect correctness.
- Code-navigation tools preserve the public protocol while switching internals from CLI search to index-first lookup.
- `code-index/index.json` is tool-private cache data. It must never be returned wholesale to the model; model-visible navigation outputs are limited to repo-map skeletons, bounded search previews, and `read_lines` slices.
