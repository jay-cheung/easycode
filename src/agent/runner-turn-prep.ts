import type { Agent } from "./types"
import type { ContextManagerLike } from "../context"
import type { InstructionInfo } from "../instruction"
import type { SkillInfo } from "../skill"
import type { ToolDef } from "../tool"
import { explorationSummaryReadinessMessage, explorationSummaryStep } from "./runner-helpers"

export function prepareProviderTurnRequest(input: {
  context: ContextManagerLike
  step: number
  maxSteps: number
  agent: Agent
  instructions: InstructionInfo[]
  skills: SkillInfo[]
  selectedSkills: SkillInfo[]
  pendingSkillLoads: SkillInfo[]
  tools: ToolDef[]
  usedTools: string[]
  activeHypothesisMessages: Array<{ role: "system"; content: string }>
}) {
  const plan = input.context.planRequest({
    step: input.step,
    agent: input.agent,
    instructions: input.instructions,
    skills: input.skills,
    selectedSkills: input.selectedSkills,
    pendingSkillLoads: input.pendingSkillLoads,
    tools: input.tools,
  })
  const shouldCheckSummaryReadiness = input.usedTools.length > 0 && input.step >= explorationSummaryStep(input.maxSteps)
  return {
    providerMessages: shouldCheckSummaryReadiness
      ? [...plan.providerMessages, ...input.activeHypothesisMessages, explorationSummaryReadinessMessage(input.step + 1, input.maxSteps)]
      : [...plan.providerMessages, ...input.activeHypothesisMessages],
    availableTools: shouldCheckSummaryReadiness ? [] : input.tools,
  }
}
