import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ProjectMemoryStore, renderProjectMemoryRecall, shouldAutoRecallProjectMemory } from "../../src/memory"
import { backupPath } from "../../src/storage"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-memory-"))
}

describe("project memory", () => {
  test("loads legacy note-style records and defaults kind to note", async () => {
    const root = await tmpdir()
    await mkdir(path.join(root, ".easycode"), { recursive: true })
    await Bun.write(path.join(root, ".easycode", "memory.json"), JSON.stringify({
      version: 1,
      records: [
        { id: "legacy_1", text: "legacy note", tags: ["task"], source: "assistant", createdAt: 1 },
      ],
    }, null, 2))

    const records = await new ProjectMemoryStore(root).list()

    expect(records).toEqual([
      expect.objectContaining({ id: "legacy_1", kind: "note", text: "legacy note", tags: ["task"] }),
    ])
    await rm(root, { recursive: true, force: true })
  })

  test("stores structured records and scores scope-aware queries", async () => {
    const root = await tmpdir()
    const store = new ProjectMemoryStore(root)
    await store.add({
      kind: "failure_pattern",
      text: "Payment retry loops were caused by a stale retry flag.",
      tags: ["payment", "retry"],
      scope: { files: ["src/payment/retry.ts"], symbols: ["RetryWorker"], topics: ["payments"] },
    })
    await store.add({
      kind: "preference",
      text: "Use Chinese for user-facing updates in this repo.",
      tags: ["language"],
      scope: { topics: ["language"] },
    })

    const scoped = await store.query("retry RetryWorker", 5)
    const filtered = await store.query("language", 5, { kinds: ["preference"] })

    expect(scoped[0]).toMatchObject({ kind: "failure_pattern", tags: ["payment", "retry"] })
    expect(filtered).toEqual([
      expect.objectContaining({ kind: "preference", text: "Use Chinese for user-facing updates in this repo." }),
    ])
    await rm(root, { recursive: true, force: true })
  })

  test("recovers from a backup when memory json is corrupted", async () => {
    const root = await tmpdir()
    const store = new ProjectMemoryStore(root)
    const first = await store.add({
      kind: "repo_fact",
      text: "The stable memory snapshot survives corruption.",
      tags: ["recovery"],
    })
    await store.add({
      kind: "repo_fact",
      text: "The latest primary record can be rebuilt after recovery.",
      tags: ["recovery"],
    })
    await Bun.write(store.filePath, "{")

    const recovered = await new ProjectMemoryStore(root).list()

    expect(recovered).toEqual([
      expect.objectContaining({ id: first.id, text: "The stable memory snapshot survives corruption." }),
    ])
    expect(await Bun.file(backupPath(store.filePath)).exists()).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("does not silently reset corrupted memory without a backup", async () => {
    const root = await tmpdir()
    const store = new ProjectMemoryStore(root)
    await mkdir(path.dirname(store.filePath), { recursive: true })
    await Bun.write(store.filePath, "{")

    await expect(store.list()).rejects.toThrow("Project memory is not valid JSON")
    await rm(root, { recursive: true, force: true })
  })

  test("renders recalled memory blocks and detects continuation-style prompts", () => {
    const rendered = renderProjectMemoryRecall([
      {
        id: "mem_1",
        kind: "session_archive",
        text: "Deleted session about APIx failures.",
        tags: ["session", "apix"],
        source: "assistant",
        createdAt: 1,
      },
    ], "继续处理 APIx")

    expect(rendered).toContain("<project_memory_recall>")
    expect(rendered).toContain("[session_archive]")
    expect(shouldAutoRecallProjectMemory("继续处理这个问题")).toBe(true)
    expect(shouldAutoRecallProjectMemory("resume the previous task")).toBe(true)
    expect(shouldAutoRecallProjectMemory("fix the test")).toBe(false)
  })

  test("promotion keeps only concise durable lessons", async () => {
    const root = await tmpdir()
    const store = new ProjectMemoryStore(root)

    const promoted = await store.promote({
      kind: "successful_workflow",
      text: " After a bounded slice, run focused tests first and bun run gate last. ",
      tags: ["workflow"],
      scope: { topics: ["verification"] },
    })

    await expect(store.promote({
      kind: "repo_fact",
      text: "x".repeat(401),
    })).rejects.toThrow("under 400 characters")

    expect(promoted.kind).toBe("successful_workflow")
    expect(promoted.text).toBe("After a bounded slice, run focused tests first and bun run gate last.")
    await rm(root, { recursive: true, force: true })
  })

  test("delete removes a record by id and returns false for missing ids", async () => {
    const root = await tmpdir()
    const store = new ProjectMemoryStore(root)

    const record = await store.add({
      kind: "task_state",
      text: "Implement onClick handler",
      tags: ["task", "checkpoint"],
      scope: { topics: ["task_checkpoint"] },
    })

    expect(await store.delete(record.id)).toBe(true)
    expect(await store.list()).toEqual([])
    expect(await store.delete(record.id)).toBe(false)
    expect(await store.delete("nonexistent_id")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("query applies trigger-word filtering, scope boost, and deduplication", async () => {
    const root = await tmpdir()
    const store = new ProjectMemoryStore(root)

    await store.add({
      kind: "session_archive",
      text: "Previous payment retry investigation concluded that a stale retry flag caused duplicate retries.",
      tags: ["payment", "retry"],
      scope: { files: ["src/payment/retry.ts"] },
    })

    await store.add({
      kind: "session_archive",
      text: "Previous payment retry investigation concluded that a stale retry flag caused duplicate retries.",
      tags: ["payment", "retry"],
      scope: { files: ["src/payment/retry.ts"] },
    })

    await store.add({
      kind: "note",
      text: "resume task before last time",
      tags: ["noise"],
    })

    const results = await store.query("resume payment retry check", 5, {
      kinds: ["session_archive", "note"],
      activeFiles: ["src/payment/retry.ts"],
    })

    expect(results.length).toBe(1)
    expect(results[0].text).toContain("stale retry flag")

    await rm(root, { recursive: true, force: true })
  })
})
