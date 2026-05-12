# Evals

## Local Eval Schema
```json
{
  "id": "EC-001",
  "mode": "build",
  "prompt": "Fix the failing test",
  "fixture": "evals/fixtures/simple-bug",
  "providers": ["fake"],
  "tools": "builtin",
  "expected": {
    "status": "passed",
    "changedFiles": ["src/add.ts"],
    "forbiddenFiles": [".env"],
    "requiredTools": ["read", "edit", "bash"],
    "maxToolCalls": 12
  }
}
```

## Initial Tasks
- `EC-001`: Fix a simple test failure.
- `EC-002`: Plan mode returns a plan and does not modify files.
- `EC-003`: Permission deny is returned as tool feedback.
- `EC-004`: `.env` read goes through permission.
- `EC-005`: Long context triggers compaction.
- `EC-006`: Skill content is progressively loaded.
- `EC-007`: Bash timeout and truncation are surfaced.
- `EC-008`: Invalid tool args can be fed back to the model.
- `EC-REAL-001`: Real provider smoke eval with no tools and output matching.

Tasks without `providers` are fake-provider deterministic evals. Real provider evals must opt in with `providers` and should avoid deterministic fake-only tool-sequence assertions unless explicitly intended.
