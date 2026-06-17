# Data Flow

```text
user input
 -> slash command parse or prompt dispatch
 -> optional image attachment merge
 -> message append
 -> context compose (agent protocol, active skills, pending skill loads, tools, ledger, summary, and bounded message suffix)
 -> provider stream
 -> UI event stream (non-logger timeline)
 -> model text/tool_call
 -> tool schema validate
 -> duplicate inspection check against completed prior tool results
 -> permission evaluate
 -> sandbox execute
 -> tool result message
 -> ledger refresh for current user trace and active capability state
 -> context length check
 -> compact if needed (provider summary first; local fallback summary if provider compaction fails)
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
  T->>T: block completed duplicate inspection when no new evidence invalidated it
  T->>P: authorize(permission, patterns)
  P-->>T: allow / ask / deny
  T->>S: execute side effect if allowed
  S-->>T: ToolResult
  T-->>A: ToolResult
  A->>M: tool_result message
```

```mermaid
sequenceDiagram
  participant A as AgentRunner
  participant C as ContextManager
  participant P as Provider
  A->>C: needsCompaction?
  C-->>A: snapshot(messages, summary)
  A->>P: summary subagent request
  alt provider summary succeeds
    P-->>A: summary text
    A->>C: compactSnapshot(summary)
  else provider summary fails
    P-->>A: provider failure
    A->>C: compactSnapshot(local fallback summary)
  end
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
