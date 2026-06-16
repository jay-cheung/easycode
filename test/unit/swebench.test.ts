import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { buildSWEBenchPrompt, captureGitDiff, formatPredictionSummaryTable, loadSWEBenchInstances, parseArgs } from "../../dev/quality/swebench"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-swebench-"))
}

describe("swebench adapter", () => {
  test("parses core CLI options", () => {
    const parsed = parseArgs([
      "--provider",
      "fake",
      "--preset",
      "verified",
      "--instance-ids",
      "a,b",
      "--limit",
      "2",
      "--max-plan-rounds",
      "5",
      "--no-hints",
      "--resume",
    ])

    expect(parsed.provider).toBe("fake")
    expect(parsed.preset).toBe("verified")
    expect(parsed.instanceIDs).toEqual(["a", "b"])
    expect(parsed.limit).toBe(2)
    expect(parsed.maxPlanRounds).toBe(5)
    expect(parsed.includeHints).toBe(false)
    expect(parsed.resume).toBe(true)
    expect(parsed.datasetPath).toBeUndefined()
    expect(parsed.outputPath).toContain("swebench-verified-smoke-fake-predictions.jsonl")
  })

  test("accepts explicit dataset and output paths", () => {
    const parsed = parseArgs([
      "--provider",
      "fake",
      "--dataset",
      "tasks.jsonl",
      "--output",
      "predictions.jsonl",
    ])

    expect(parsed.datasetPath).toContain("tasks.jsonl")
    expect(parsed.outputPath).toContain("predictions.jsonl")
  })

  test("loads jsonl datasets with the expected fields", async () => {
    const root = await tmpdir()
    try {
      const file = path.join(root, "instances.jsonl")
      await writeFile(file, `${JSON.stringify({
        instance_id: "repo__issue-1",
        repo: "owner/repo",
        base_commit: "abc123",
        problem_statement: "Fix the bug.",
        hints_text: "Look at parser.ts",
      })}\n`)

      const rows = await loadSWEBenchInstances(file)
      expect(rows).toEqual([
        {
          instance_id: "repo__issue-1",
          repo: "owner/repo",
          base_commit: "abc123",
          problem_statement: "Fix the bug.",
          hints_text: "Look at parser.ts",
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("builds a prompt with issue text and hints", () => {
    const prompt = buildSWEBenchPrompt({
      instance_id: "django__django-123",
      repo: "django/django",
      base_commit: "deadbeef",
      problem_statement: "The serializer drops empty lists.",
      hints_text: "The regression started around the validation helpers.",
    })

    expect(prompt).toContain("SWE-bench instance: django__django-123")
    expect(prompt).toContain("GitHub issue:")
    expect(prompt).toContain("The serializer drops empty lists.")
    expect(prompt).toContain("Hints:")
  })

  test("captures a git diff from a modified worktree", async () => {
    const root = await tmpdir()
    try {
      await Bun.$`git init ${root}`.quiet()
      await Bun.$`git -C ${root} config user.email easycode@example.com`.quiet()
      await Bun.$`git -C ${root} config user.name EasyCode`.quiet()
      await writeFile(path.join(root, "demo.txt"), "before\n")
      await Bun.$`git -C ${root} add demo.txt`.quiet()
      await Bun.$`git -C ${root} commit -m init`.quiet()
      await writeFile(path.join(root, "demo.txt"), "after\n")

      const diff = await captureGitDiff(root)
      expect(diff).toContain("diff --git a/demo.txt b/demo.txt")
      expect(diff).toContain("+after")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("formats a visual prediction summary table", () => {
    const table = formatPredictionSummaryTable([
      {
        instance: {
          instance_id: "repo__issue-1",
          repo: "owner/repo",
          base_commit: "abc123",
          problem_statement: "Fix the bug.",
        },
        prediction: {
          instance_id: "repo__issue-1",
          model_name_or_path: "easycode/fake",
          model_patch: null,
        },
        status: "failed",
        planRounds: 4,
        reason: "exceeded max plan rounds (4)",
      },
    ])

    expect(table).toContain("| Instance")
    expect(table).toContain("| repo__issue-1")
    expect(table).toContain("| FAIL")
    expect(table).toContain("exceeded max plan rounds")
  })
})
