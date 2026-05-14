# Data Flow

```text
user input
 -> slash command parse or prompt dispatch
 -> optional image attachment merge
 -> message append
 -> context compose (static agent/skill/tool descriptions on first provider turn only)
 -> provider stream
 -> UI event stream (non-logger timeline)
 -> model text/tool_call
 -> tool schema validate
 -> permission evaluate
 -> sandbox execute
 -> tool result message
 -> context length check
 -> compact if needed
 -> final answer
```

```mermaid
sequenceDiagram
  participant M as Model
  participant A as AgentRunner
  participant T as ToolRegistry
  participant P as PermissionService
  participant S as Sandbox
  M->>A: tool_call(name, input)
  A->>T: run(name, input)
  T->>T: validate Zod schema
  T->>P: authorize(permission, patterns)
  P-->>T: allow / ask / deny
  T->>S: execute side effect if allowed
  S-->>T: ToolResult
  T-->>A: ToolResult
  A->>M: tool_result message
```

```mermaid
sequenceDiagram
  participant U as User
  participant C as CLI
  participant A as AgentRunner
  participant R as TimelineRenderer
  U->>C: /image path
  C->>C: validate capability and queue image
  U->>C: prompt
  C->>A: run(prompt, images)
  A->>R: reasoning_delta / tool_call / text_delta
  R-->>U: Thought / Tool / Answer timeline
```
