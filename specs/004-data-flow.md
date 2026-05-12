# Data Flow

```text
user input
 -> message append
 -> context compose (static agent/skill/tool descriptions on first provider turn only)
 -> provider stream
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
