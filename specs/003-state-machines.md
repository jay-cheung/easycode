# State Machines

## Agent Run
```text
idle -> preparing -> streaming -> tool_pending -> tool_running -> streaming -> completed | failed | cancelled
```

## Tool Call
```text
pending -> permission_check -> denied | running -> succeeded | failed
```

## Permission
```text
evaluate -> allow | deny | ask -> once | always | reject
once + repeat-safe metadata -> session approval cache
```

## Context
```text
normal -> near_limit -> compacting -> compacted -> normal
```

## Planning Layer
```text
idle -> drafting -> awaiting_approval -> executing_step -> completed
                                      \-> replanning --------^
                                      \-> blocked
```

## Rules
- A denied tool call never reaches sandbox execution.
- Invalid tool input returns structured feedback to the model.
- Returning `<proposed_plan>` never performs writes before approval.
- Step execution advances only through explicit step completion or replanning.
- Context compaction preserves the most recent three turns by default.
