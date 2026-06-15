# EasyCode Memory Module Spec And Roadmap

## Objective

Give EasyCode a practical memory stack that improves cross-turn and cross-session continuity for coding work without polluting the prompt, breaking prompt-cache reuse, or storing low-signal tool noise as if it were durable truth.

## Current Baseline

EasyCode already has three partial memory layers:

1. Working context in the active message window.
2. A compaction summary for older turns.
3. A structured context ledger for current intent, constraints, decisions, and failures.

The remaining gap is project memory. Today `src/memory.ts` stores short free-text records in `.easycode/memory.json`, supports keyword query, and is used mainly for deleted-session archival. It is not yet structured enough for reliable recall, reflection, or evaluation.

## Design Principles

- Runtime truth beats memory. Files, tool outputs, and current user input override stored memory.
- Short-term memory and long-term memory stay distinct.
- Write less, but write structured records with clear recall value.
- Recall is conditional, not automatic on every turn.
- Memory should help the model skip repeated setup, not add prompt noise.
- Do not store secrets, raw logs, or large opaque blobs.
- Start local and deterministic before adding embeddings or external stores.

## Memory Model

### Short-Term Memory

Short-term memory stays inside the current run and session:

- Active message suffix.
- Compaction summary.
- Structured context ledger.

This layer tracks the current task boundary, active hypothesis, recent evidence, constraints, and selected capabilities.

### Long-Term Memory

Long-term memory is project-scoped and persisted in `.easycode/memory.json`.

Each durable record should have:

- `kind`: semantic category for retrieval and recall policy.
- `text`: short sanitized human-readable content.
- `tags`: lightweight search helpers.
- `scope`: optional files, symbols, and topics.
- `source`: user, assistant, or tool.
- `createdAt`: stable ordering timestamp.

Initial record kinds:

- `note`: generic manual note or backward-compatible legacy record.
- `session_archive`: deleted-session summary.
- `preference`: durable user preference.
- `repo_fact`: repeatedly useful repository fact.
- `failure_pattern`: recurring failure and its diagnosis.
- `successful_workflow`: reusable workflow that repeatedly succeeds.

## Write Policy

Long-term memory writes must be selective.

Write automatically only when:

- A session is deleted and its summary should remain queryable.
- A repeated failure pattern or successful workflow is explicitly promoted.
- A cross-session task state is intentionally checkpointed.

Write manually when:

- The model uses `memory_add`.

Do not automatically write:

- Raw command output.
- Full diffs.
- Secrets or credential-bearing content.
- One-off low-signal chatter.

## Recall Policy

Recall should run only when the prompt suggests prior context matters, for example:

- `继续`
- `之前`
- `上次`
- `resume`
- `continue`
- `previous`
- `last time`

Recalled memory should be injected as a small explicit runtime block, not silently merged into user text. It should also be reflected in the ledger so compaction and diagnostics can preserve that recall event.

## Reflection And Promotion

Reflection is a later phase. The desired pipeline is:

- Observe short-term evidence during the run.
- Distill only high-value lessons.
- Promote those lessons into long-term memory with a typed record.

Promotion should require either repeated evidence or an explicit checkpoint action. EasyCode should not treat every summary or every tool result as durable memory.

## Retrieval Strategy

Phase 1 retrieval remains local and deterministic:

- keyword terms
- tags
- scoped file/symbol/topic overlap
- recency tiebreaking

Embeddings or vector retrieval are explicitly out of scope until structured local memory proves useful and low-noise.

## Acceptance

- Project memory records are structured and backward-compatible with existing `.easycode/memory.json`.
- `memory_add` can write typed records with optional scope.
- `memory_query` returns structured memory in a readable format.
- Deleted sessions are archived as `session_archive` records instead of anonymous text-only notes.
- Continuation-style prompts trigger bounded automatic recall from project memory.
- Auto-recalled memory is visible in the runtime context and traceable in the ledger.
- Tests cover structured storage, backward compatibility, session archive typing, and auto-recall injection.

## Roadmap

### Phase 1: Structured Memory And Conditional Recall

- Add typed project memory records with optional scope.
- Preserve backward compatibility for old note-style records.
- Upgrade session deletion archival to `session_archive`.
- Add bounded auto recall for continuation-like prompts.
- Add tests and progress-log coverage.

### Phase 2: Promotion Paths For Durable Lessons

- Add explicit promotion helpers for `preference`, `repo_fact`, `failure_pattern`, and `successful_workflow`.
- Add guardrails so only concise structured records are promoted.
- Add prompt/tool guidance for when promotion is appropriate.
- Add fake-provider eval coverage for continuation recall and durable promotion.
- Status: implemented in runtime through `memory_promote`. Automatic reflection-driven promotion remains intentionally out of scope for the local deterministic roadmap and is not required for completion.

### Phase 3: Session And Task Checkpoint Memory

- Keep active plans and goals session-local instead of resuming them after exit or session switch.
- Distinguish durable project memory from transient execution state.
- Status: cross-session task checkpointing was removed. `task_state` remains readable only for backward compatibility with older memory files, while runtime continuation relies on live session state plus session archives for long-term retention.

### Phase 4: Memory Evals

- Add eval fixtures for continuation, repeated failure recovery, preference retention, and noise rejection.
- Verify that recalled memory improves trajectory without causing irrelevant prompt pollution.
- Status: implemented through `EC-010` to `EC-014` in the default fake-provider eval suite.

### Phase 5: Retrieval Refinement

- Improve ranking, deduplication, and scope-aware filtering.
- Only consider embeddings or vector retrieval if structured local retrieval becomes the clear bottleneck.
- Status: implemented locally with trigger-word filtering, active-file scope boosts, deduplication, and bounded recall. Embeddings remain intentionally deferred unless the local path becomes the bottleneck.
