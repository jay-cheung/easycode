export const BASE_COMPACT_PROMPT = [
  "Produce one durable working summary for a coding session continuation.",
  "The summary is internal context for a future EasyCode run, not a user-facing answer.",
  "Keep only facts that matter for correctness, continuity, and the immediate next step.",
  "",
  "Include these sections in order when relevant:",
  "1. Objective: the latest user request and the active task boundary.",
  "2. Repo facts: files inspected or changed, relevant symbols, commands, tests, outputs, and error text.",
  "3. Decisions and constraints: accepted approaches, user preferences, environment limits, and important do-not-do rules.",
  "4. Progress and remaining work: what is done, what still needs to happen, and any unresolved risk.",
  "5. Next step: the immediate next action that best matches the latest user request.",
  "",
  "Rules:",
  "- Return only <summary>...</summary>.",
  "- Do not emit <analysis> or any other wrapper.",
  "- Prefer bullets and short paragraphs over long narrative.",
  "- Preserve exact file paths, commands, identifiers, versions, and error text when they matter.",
  "- Omit repetitive chatter, routine tool noise, and duplicated facts.",
  "- If a section has nothing important, omit that section.",
  "- Additional summary instructions from the conversation still apply.",
].join("\n")

export function buildCompactPrompt(transcript: string) {
  return `${BASE_COMPACT_PROMPT}\n\nConversation to summarize:\n<conversation>\n${transcript}\n</conversation>`
}
