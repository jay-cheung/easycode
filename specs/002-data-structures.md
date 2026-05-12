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
```

## Invariants
- Tool calls and tool results are represented as message parts.
- Provider-facing messages are derived from internal messages.
- Tool metadata includes status and safety metadata where relevant.
- Zod validates model-produced tool arguments before execution.
