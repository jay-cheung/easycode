import type { Agent } from "../agent/types"
import type { InstructionInfo } from "../instruction"
import type { ProviderInputMessage } from "../message"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"

const contextExecutionContract = [
  "Context execution contract:",
  "- Treat the current prompt, selected context ledger, summary, and message history as the complete available state unless the user explicitly says otherwise.",
  "- Answer the latest user request directly; do not ask for prior turns that are already represented in summaries, ledgers, fixtures, or placeholders.",
  "- Resolve pronouns, implicit intent, latest overrides, preferences, conflicts, and task progress from the active window plus the context ledger before responding.",
  "- Preserve exact user-supplied entity names, versions, paths, identifiers, and constraints when they are relevant.",
  "- Prefer current ledger records over older summary text when they conflict; history records explain previous decisions but do not override current records.",
  "- Keep dynamic run facts in the ledger or message history, after the stable static prefix, to protect prompt-cache reuse.",
].join("\n")

// Keep exploration policy in the stable system prefix so every provider turn
// gets the same tool-ordering contract without duplicating schemas.
const toolPriorityDirective = [
  "Code exploration order:",
  "1. repo_map with query.",
  "2. find_definition / find_references / rg_search.",
  "3. call_graph for bounded callers/callees.",
  "4. read_lines for exact ranges.",
  "5. list / git_diff / read / grep / edit|write / bash.",
  "Before edit/write or a code-change recommendation, produce a symbol-aware edit plan for symbol-affecting work: target symbols, owning definitions, affected references or callers, excluded same-name matches, and verification.",
  "Do not full-read files over 100 lines. Never read or expose .easycode/cache/code-index/index.json.",
].join("\n")

export function buildContextSystemPrompt(agent: Pick<Agent, "systemPrompt" | "mode">) {
  return [agent.systemPrompt, contextExecutionContract, `Mode: ${agent.mode}`, toolPriorityDirective].join("\n\n")
}

export function buildInstructionPrompt(instructions: InstructionInfo[]) {
  if (instructions.length === 0) return ""
  return [
    "Repository and user instruction files. Follow these durable instructions unless they conflict with higher-priority system/developer instructions or the latest user request.",
    ...instructions.map(formatInstruction),
  ].join("\n\n")
}

function formatInstruction(instruction: InstructionInfo) {
  return `<instruction source="${instruction.source}" path="${instruction.path}">\n${instruction.content}\n</instruction>`
}

export function buildSkillPrompt(skills: SkillInfo[], selectedSkills: SkillInfo[], pendingSkillLoads: SkillInfo[]) {
  if (skills.length === 0 && selectedSkills.length === 0) return ""
  const skillList = sortedSkills(skills).map(formatSkillDescription).join("\n") || "(none)"
  const selected = sortedSkills(selectedSkills).map(formatSkillDescription).join("\n") || "(none)"
  const selectedSkillList = `Active skills, descriptions only. Load full instructions with the skill tool when needed:\n${selected}`
  const pending = sortedSkills(pendingSkillLoads).map(formatSkillDescription).join("\n")
  const pendingPrompt = pending
    ? `First-use skill load required. Before answering or taking task-specific action, you MUST call the skill tool for each listed skill, then follow the returned instructions:\n${pending}`
    : ""
  return [`Available skills, descriptions only until skill tool is called:\n${skillList}`, `Selected skill instructions:\n${selectedSkillList}`, pendingPrompt].filter(Boolean).join("\n\n")
}

export function hasSkillPrompt(skills: SkillInfo[], selectedSkills: SkillInfo[]) {
  return skills.length > 0 || selectedSkills.length > 0
}

export function buildTextToolProtocolPrompt(tools: ToolDef[]): ProviderInputMessage {
  return {
    role: "system",
    content: [
      "Text tool protocol:",
      "This model endpoint does not receive native tool schemas. When a tool is needed, emit exactly one XML block and no markdown fence:",
      '<easycode_tool_call name="tool_name" id="optional_call_id">{"argument":"value"}</easycode_tool_call>',
      "Available tools:",
      ...tools.map(formatTextTool),
    ].join("\n"),
  }
}

function sortedSkills(skills: SkillInfo[]) {
  return [...skills].sort((left, right) => left.name.localeCompare(right.name))
}

function formatSkillDescription(skill: SkillInfo) {
  return `- ${skill.name}: ${skill.description}`
}

function formatTextTool(tool: ToolDef) {
  return `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.jsonSchema)}`
}
