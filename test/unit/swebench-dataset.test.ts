import { describe, expect, test } from "bun:test"
import { parseArgs } from "../../dev/quality/swebench-dataset"

describe("swebench dataset exporter", () => {
  test("parses preset, limit, and instance ids", () => {
    const parsed = parseArgs([
      "--preset",
      "verified",
      "--limit",
      "5",
      "--offset",
      "2",
      "--instance-ids",
      "a,b,c",
      "--output",
      "custom.jsonl",
    ])

    expect(parsed.preset).toBe("verified")
    expect(parsed.limit).toBe(5)
    expect(parsed.offset).toBe(2)
    expect(parsed.instanceIDs).toEqual(["a", "b", "c"])
    expect(parsed.outputPath).toContain("custom.jsonl")
  })
})
