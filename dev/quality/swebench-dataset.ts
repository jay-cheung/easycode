#!/usr/bin/env bun
import path from "node:path"
import { mkdir } from "node:fs/promises"

export type SWEBenchDatasetPreset = "lite" | "verified"

export type SWEBenchDatasetRow = {
  repo: string
  instance_id: string
  base_commit: string
  patch?: string
  test_patch?: string
  problem_statement: string
  hints_text?: string | null
  created_at?: string
  version?: string
  FAIL_TO_PASS?: string
  PASS_TO_PASS?: string
  environment_setup_commit?: string
  difficulty?: string
}

export type SWEBenchDatasetExportOptions = {
  preset: SWEBenchDatasetPreset
  outputPath: string
  limit: number
  offset: number
  instanceIDs?: string[]
}

const presetDatasetName: Record<SWEBenchDatasetPreset, string> = {
  lite: "SWE-bench/SWE-bench_Lite",
  verified: "SWE-bench/SWE-bench_Verified",
}

const bundledSmokeFiles: Record<SWEBenchDatasetPreset, string> = {
  lite: "evals/swebench/lite-smoke.jsonl",
  verified: "evals/swebench/verified-smoke.jsonl",
}

export function parseArgs(argv: string[]): SWEBenchDatasetExportOptions {
  const preset = (optionalStringFlag(argv, "--preset") ?? "lite") as SWEBenchDatasetPreset
  if (preset !== "lite" && preset !== "verified") throw new Error("--preset must be lite or verified")
  const outputPath = path.resolve(optionalStringFlag(argv, "--output") ?? bundledSmokeFiles[preset])
  const limit = optionalPositiveNumberFlag(argv, "--limit") ?? 3
  const offset = optionalNonNegativeNumberFlag(argv, "--offset") ?? 0
  const instanceIDs = optionalStringFlag(argv, "--instance-ids")?.split(",").map((value) => value.trim()).filter(Boolean)
  return { preset, outputPath, limit, offset, instanceIDs }
}

function optionalStringFlag(argv: string[], name: string) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function optionalPositiveNumberFlag(argv: string[], name: string) {
  const raw = optionalStringFlag(argv, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`)
  return Math.round(value)
}

function optionalNonNegativeNumberFlag(argv: string[], name: string) {
  const raw = optionalStringFlag(argv, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a non-negative number`)
  return Math.round(value)
}

function datasetRowsUrl(options: { preset: SWEBenchDatasetPreset; offset: number; length: number }) {
  const dataset = encodeURIComponent(presetDatasetName[options.preset])
  return `https://datasets-server.huggingface.co/rows?dataset=${dataset}&config=default&split=test&offset=${options.offset}&length=${options.length}`
}

export async function fetchPresetRows(options: { preset: SWEBenchDatasetPreset; offset?: number; length?: number }) {
  const response = await fetch(datasetRowsUrl({
    preset: options.preset,
    offset: options.offset ?? 0,
    length: options.length ?? 3,
  }))
  if (!response.ok) throw new Error(`failed to fetch dataset rows: ${response.status} ${response.statusText}`)
  const payload = await response.json() as { rows?: Array<{ row?: SWEBenchDatasetRow }> }
  return (payload.rows ?? []).flatMap((entry) => (entry.row ? [entry.row] : []))
}

export async function exportDataset(options: SWEBenchDatasetExportOptions) {
  const rows = options.instanceIDs?.length
    ? await fetchRowsByInstanceIDs(options.preset, options.instanceIDs)
    : await fetchPresetRows({ preset: options.preset, offset: options.offset, length: options.limit })
  const trimmed = rows.slice(0, options.limit).map(trimRow)
  await mkdir(path.dirname(options.outputPath), { recursive: true })
  await Bun.write(options.outputPath, `${trimmed.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return { rows: trimmed, outputPath: options.outputPath }
}

async function fetchRowsByInstanceIDs(preset: SWEBenchDatasetPreset, instanceIDs: string[]) {
  const wanted = new Set(instanceIDs)
  const found = new Map<string, SWEBenchDatasetRow>()
  let offset = 0
  const batchSize = 100
  while (found.size < wanted.size) {
    const rows = await fetchPresetRows({ preset, offset, length: batchSize })
    if (rows.length === 0) break
    for (const row of rows) {
      if (wanted.has(row.instance_id)) found.set(row.instance_id, row)
    }
    offset += rows.length
  }
  const missing = instanceIDs.filter((id) => !found.has(id))
  if (missing.length > 0) throw new Error(`instance ids not found in ${preset}: ${missing.join(", ")}`)
  return instanceIDs.map((id) => found.get(id) as SWEBenchDatasetRow)
}

function trimRow(row: SWEBenchDatasetRow) {
  return {
    repo: row.repo,
    instance_id: row.instance_id,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    hints_text: row.hints_text ?? null,
  }
}

export function usage() {
  return [
    "Usage: bun run swebench:dataset [options]",
    "",
    "Options:",
    "  --preset <lite|verified>   Dataset preset to export (default: lite)",
    "  --output <path>            Output JSONL path (defaults to evals/swebench/<preset>-smoke.jsonl)",
    "  --limit <n>                Number of rows to export (default: 3)",
    "  --offset <n>               Start offset for contiguous export (default: 0)",
    "  --instance-ids <a,b>       Export specific instance ids instead of a contiguous slice",
  ].join("\n")
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2)
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(usage())
      process.exit(0)
    }
    const result = await exportDataset(parseArgs(argv))
    console.log(`Wrote ${result.rows.length} rows to ${result.outputPath}`)
    for (const row of result.rows) console.log(`- ${row.instance_id} (${row.repo})`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error("")
    console.error(usage())
    process.exit(1)
  }
}
