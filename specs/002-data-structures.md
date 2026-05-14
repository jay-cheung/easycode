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
}

type ContextState = {
  messages: Message[]
  summary?: string
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
```

## Invariants
- Tool calls and tool results are represented as message parts.
- Thinking and images are represented as message parts, not folded into final assistant text.
- Provider-facing messages are derived from internal messages.
- Tool metadata includes status and safety metadata where relevant.
- Zod validates model-produced tool arguments before execution.
- Session settings persist model/thinking/effort/skill choices; pending images do not persist.
