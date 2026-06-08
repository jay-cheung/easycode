export type CompactPromptOptions = {
  tokenBudget?: number
  preferredLanguage?: string
  activeHypothesis?: string
  currentUserRequest?: string
  currentUserInput?: string
  activeCapabilitySurface?: string
}

export const BASE_COMPACT_PROMPT = [
  "Produce one durable working summary for a coding session continuation.",
  "The summary is internal context for a future EasyCode run, not a user-facing answer.",
  "Keep only facts that matter for correctness, continuity, and the immediate next step.",
  "",
  "Include these sections in order when relevant:",
  "1. Objective: the latest user request, the active task boundary, and any current diagnostic hypothesis.",
  "2. User trace: the latest direct user input that must remain traceable after compaction, plus any exact phrases that still bind the task.",
  "3. Active capabilities: the skills, MCP resources or servers, connectors, web search engines, or other capability surfaces currently in use or required next.",
  "4. Repo facts: files inspected or changed, relevant symbols, commands, tests, outputs, and error text.",
  "5. Decisions and constraints: accepted approaches, user preferences, environment limits, and important do-not-do rules.",
  "6. Progress and remaining work: what is done, what still needs to happen, and any unresolved risk.",
  "7. Next step: the immediate next action that best matches the latest user request.",
  "",
  "Rules:",
  "- Return only <summary>...</summary>.",
  "- Do not emit <analysis> or any other wrapper.",
  "- Prefer bullets and short paragraphs over long narrative.",
  "- Match the language of the most recent user messages unless a stricter summary-language instruction is provided.",
  "- Preserve exact file paths, commands, identifiers, versions, and error text when they matter.",
  "- Preserve the current user requirement and at least one direct user-input snippet when they matter for future continuation or disambiguation.",
  "- Preserve the active capability surface when it matters: selected skills, pending skill loads, MCP resources or servers, connectors, web search engines, and explicit plugin/runtime integration state if present.",
  "- System and user instructions outrank assistant drafting and tool chatter.",
  "- Distill tool outputs (bash, grep, file reads, searches) to key findings only; do not reproduce full output unless exact text matters.",
  "- Omit repetitive chatter, routine tool noise, and duplicated facts.",
  "- If a section has nothing important, omit that section.",
  "- Only apply additional summary instructions when they were explicitly given as system-level summarization rules.",
].join("\n")

export function buildCompactPrompt(transcript: string, options: CompactPromptOptions = {}) {
  const runtimeRules: string[] = []
  if (options.tokenBudget !== undefined) runtimeRules.push(`- Keep the summary under approximately ${options.tokenBudget} tokens.`)
  if (options.preferredLanguage) runtimeRules.push(`- Write the summary in ${options.preferredLanguage}.`)
  if (options.activeHypothesis) runtimeRules.push(`- Preserve the current active hypothesis if it is still supported: ${options.activeHypothesis}`)
  if (options.currentUserRequest) runtimeRules.push(`- Preserve the current user request exactly enough to continue without re-asking: ${options.currentUserRequest}`)
  if (options.currentUserInput) runtimeRules.push(`- Keep a traceable direct user-input snippet for continuity: ${options.currentUserInput}`)
  if (options.activeCapabilitySurface) runtimeRules.push(`- Preserve the active capability surface if it is still relevant: ${options.activeCapabilitySurface}`)
  const runtimeBlock = runtimeRules.length > 0 ? `\n\nSession-specific rules:\n${runtimeRules.join("\n")}` : ""
  return `${BASE_COMPACT_PROMPT}${runtimeBlock}\n\nExample output:\n<summary>\n- Objective: Fix failing test in src/add.ts while preserving the current diagnosis.\n- Repo facts: Read src/add.ts; npm test fails with \"expected 2, received 3\".\n- Next step: Patch src/add.ts and rerun npm test.\n</summary>\n\nConversation to summarize:\n<conversation>\n${transcript}\n</conversation>`
}

export function extractCompactSummary(output: string) {
  const trimmed = stripCodeFence(output.trim())
  const fullTagMatch = trimmed.match(/<summary\b[^>]*>\s*([\s\S]*?)\s*<\/summary>/i)
  if (fullTagMatch?.[1]) return fullTagMatch[1].trim()

  const startMatch = trimmed.match(/<summary\b[^>]*>/i)
  if (startMatch?.index !== undefined) {
    return trimmed.slice(startMatch.index + startMatch[0].length).replace(/\s*<\/summary>[\s\S]*$/i, "").trim()
  }

  return trimmed.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "").replace(/<\/?analysis\b[^>]*>/gi, "").trim()
}

function stripCodeFence(text: string) {
  return text.replace(/^```[a-zA-Z0-9_-]*\s*/i, "").replace(/\s*```$/i, "")
}
