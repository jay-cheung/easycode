import path from "node:path"
import { hasProvider, listProviders } from "../../provider"
import { formatReport } from "./report"
import { runAPIxEval } from "./runner"
import type { APIxCase, APIxOptions } from "./types"

function parseArgs(argv: string[]): APIxOptions {
  const root = path.resolve(valueAfter(argv, "--root") ?? path.resolve(import.meta.dir, "../../.."))
  const provider = valueAfter(argv, "--provider") ?? "deepseek"
  if (!hasProvider(provider)) throw new Error(`Unknown provider: ${provider}. Available providers: ${listProviders().join(", ")}`)
  const priority = valueAfter(argv, "--priority") as APIxCase["priority"] | undefined
  if (priority && !["P0", "P1", "P2"].includes(priority)) throw new Error("--priority must be P0, P1, or P2")
  const ids = valueAfter(argv, "--ids")?.split(",").map((item) => item.trim()).filter(Boolean)
  const limit = valueAfter(argv, "--limit")
  const maxOutputTokens = valueAfter(argv, "--max-output-tokens")
  return {
    root,
    provider,
    model: valueAfter(argv, "--model"),
    priority,
    dimension: valueAfter(argv, "--dimension"),
    ids,
    limit: limit === undefined ? undefined : Number(limit),
    thinking: argv.includes("--thinking"),
    maxOutputTokens: maxOutputTokens === undefined ? undefined : Number(maxOutputTokens),
    json: argv.includes("--json"),
    table: argv.includes("--table"),
    quiet: argv.includes("--quiet"),
  }
}

function valueAfter(argv: string[], flag: string) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

export async function runAPIxEvalCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const report = await runAPIxEval(options)
  console.log(options.table ? formatReport(report) : JSON.stringify(report, null, 2))
  if (report.results.some((result) => !result.scoreOnly && !result.passed)) process.exit(1)
  return report
}

