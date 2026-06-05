import type { ContextManagerLike, LedgerRecord } from "../../context"
import { CliCodeNavigator } from "../../tool/code-navigator"
import type { Sandbox } from "../../sandbox"
import type { RunUiEvent } from "../../ui/timeline"
import { ledgerRecord } from "../ledger"

type RepoMapRefreshDeps = {
  sandbox: Sandbox
  context: ContextManagerLike
  onEvent?: (event: RunUiEvent) => void
  truncateForLedger: (text: string, maxLength: number) => string
}

export async function refreshRepoMapCache(
  deps: RepoMapRefreshDeps,
  signal: AbortSignal | undefined,
  prompt: string | undefined,
) {
  if (signal?.aborted) return
  const turn = deps.context.state.messages.length
  try {
    const map = await new CliCodeNavigator(deps.sandbox, { signal }).repoMap({})

    let checkpointText = `repo_map ${map.cache.hit ? "cache hit" : "refreshed"}: ${map.entries.length} files at ${map.cache.path}`
    let dynamicMapRecord: LedgerRecord | undefined
    let relevantFiles: number | undefined

    if (prompt) {
      const filteredMap = await new CliCodeNavigator(deps.sandbox, { signal }).repoMap({ query: prompt })
      if (filteredMap.entries.length > 0) {
        relevantFiles = filteredMap.entries.length
        checkpointText += ` (query-targeted subset containing ${filteredMap.entries.length} relevant files)`
        dynamicMapRecord = ledgerRecord(
          "checkpoint",
          "query_targeted_repo_map",
          `query-targeted repo_map prepared: ${filteredMap.entries.length} relevant files. Use repo_map with query="${deps.truncateForLedger(prompt, 80)}" to fetch the current skeleton instead of reading whole files.`,
          "current",
          turn,
          { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } },
        )
      }
    }
    deps.onEvent?.({ type: "repo_map", status: "succeeded", cacheHit: map.cache.hit, files: map.entries.length, relevantFiles, cachePath: map.cache.path })

    deps.context.updateLedger({
      current: [
        ledgerRecord("checkpoint", "repo_map_cache", checkpointText, "current", turn, { evidence: { source: "assistant" }, scope: { files: [map.cache.path], topics: ["repo_map", "code_navigation"] } }),
        ledgerRecord("constraint", "code_navigation_entrypoint", "repo_map cache is prewarmed at conversation start; prefer repo_map, find_definition, rg_search, and read_lines before grep or full-file read.", "current", turn, { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }),
        ...(dynamicMapRecord ? [dynamicMapRecord] : []),
      ],
    })
  } catch (error) {
    deps.onEvent?.({ type: "repo_map", status: "failed", error: error instanceof Error ? error.message : String(error) })
    deps.context.updateLedger({
      current: [
        ledgerRecord("failure", "repo_map_prewarm_failure", error instanceof Error ? error.message : String(error), "current", turn, { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }),
        ledgerRecord("constraint", "code_navigation_fallback", "repo_map prewarm failed; use find_definition, rg_search, read_lines, and grep fallback with bounded results.", "current", turn, { evidence: { source: "assistant" }, scope: { topics: ["repo_map", "code_navigation"] } }),
      ],
    })
  }
}
