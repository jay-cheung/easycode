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
```

## Context
```text
normal -> near_limit -> compacting -> compacted -> normal
```

## Plan Mode
```text
readonly -> proposed_plan -> completed
```

## Rules
- A denied tool call never reaches sandbox execution.
- Invalid tool input returns structured feedback to the model.
- Plan mode cannot transition into write/edit side effects.
- Context compaction preserves the most recent two turns.
