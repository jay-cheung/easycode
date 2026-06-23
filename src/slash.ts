import { uiText, type SlashErrorCode, type UiLanguage } from "./i18n"

export const canonicalSlashCommandNames = [
  "/help",
  "/settings",
  "/cancel",
  "/plan",
  "/goal",
  "/sessions",
  "/session",
  "/image",
  "/file",
  "/skill",
  "/model",
  "/provider",
  "/max-tokens",
  "/max-steps",
  "/effort",
  "/lang",
  "/thinking",
] as const

export type SlashCommand =
  | { type: "prompt"; text: string }
  | { type: "help" }
  | { type: "settings" }
  | { type: "cancel" }
  | { type: "plan"; objective: string }
  | { type: "goal"; action: "start"; objective: string }
  | { type: "goal"; action: "status" | "pause" | "resume" | "clear" }
  | { type: "sessions" }
  | { type: "session"; action: "switch" | "delete"; target: string }
  | { type: "image"; action: "add"; value: string }
  | { type: "image"; action: "clear" }
  | { type: "file"; action: "add"; value: string }
  | { type: "file"; action: "clear" }
  | { type: "skill"; action: "list" }
  | { type: "skill"; action: "use"; name: string }
  | { type: "skill"; action: "remove"; name: string }
  | { type: "skill"; action: "clear" }
  | { type: "model"; model?: string }
  | { type: "provider"; name: string }
  | { type: "maxTokens"; value?: number }
  | { type: "maxSteps"; value?: number }
  | { type: "effort"; value: string }
  | { type: "lang"; value?: string }
  | { type: "thinking"; value: "on" | "off"; aliasUsed?: boolean }
  | { type: "unknown"; name: string }
  | { type: "error"; code: SlashErrorCode }

export function parseSlashCommand(input: string): SlashCommand {
  if (!input.startsWith("/")) return { type: "prompt", text: input }
  if (input.startsWith("//")) return { type: "prompt", text: input.slice(1) }
  const trimmed = input.trim()
  const [rawName = "", ...args] = trimmed.slice(1).split(/\s+/)
  const name = rawName.toLowerCase()
  if (!name) return { type: "help" }
  if (name === "help") return { type: "help" }
  if (name === "settings") return { type: "settings" }
  if (name === "cancel" || name === "stop") return { type: "cancel" }
  if (name === "plan") {
    const objective = args.join(" ")
    return objective ? { type: "plan", objective } : { type: "error", code: "plan_requires_objective" }
  }
  if (name === "goal") {
    const action = args[0]?.toLowerCase()
    if (!action || action === "status" || action === "show" || action === "list") return { type: "goal", action: "status" }
    if (action === "pause") return { type: "goal", action: "pause" }
    if (action === "resume") return { type: "goal", action: "resume" }
    if (action === "clear" || action === "stop" || action === "cancel" || action === "rm") return { type: "goal", action: "clear" }
    return { type: "goal", action: "start", objective: args.join(" ") }
  }
  if (name === "sessions") return { type: "sessions" }
  if (name === "session") {
    const action = args[0]?.toLowerCase()
    const target = args.slice(1).join(" ")
    if (!action || action === "list") return { type: "sessions" }
    if (action === "switch" || action === "use" || action === "select") {
      return target ? { type: "session", action: "switch", target } : { type: "error", code: "session_switch_requires_name" }
    }
    if (action === "delete" || action === "remove" || action === "rm") {
      return target ? { type: "session", action: "delete", target } : { type: "error", code: "session_delete_requires_name" }
    }
    return { type: "session", action: "switch", target: args.join(" ") }
  }
  if (name === "image") {
    if (args[0]?.toLowerCase() === "clear") return { type: "image", action: "clear" }
    const value = args.join(" ")
    return value ? { type: "image", action: "add", value } : { type: "error", code: "image_requires_value" }
  }
  if (name === "file") {
    if (args[0]?.toLowerCase() === "clear") return { type: "file", action: "clear" }
    const value = args.join(" ")
    return value ? { type: "file", action: "add", value } : { type: "error", code: "file_requires_value" }
  }
  if (name === "skill") {
    const action = args[0]?.toLowerCase()
    if (!action || action === "list") return { type: "skill", action: "list" }
    if (action === "clear") return { type: "skill", action: "clear" }
    if (action === "remove") {
      const skillName = args.slice(1).join(" ")
      return skillName ? { type: "skill", action: "remove", name: skillName } : { type: "error", code: "skill_remove_requires_name" }
    }
    if (action === "use") {
      const skillName = args.slice(1).join(" ")
      return skillName ? { type: "skill", action: "use", name: skillName } : { type: "error", code: "skill_use_requires_name" }
    }
    return { type: "skill", action: "use", name: args.join(" ") }
  }
  if (name === "model") {
    if (args[0] && ["reset", "clear", "default"].includes(args[0].toLowerCase()) && args.length === 1) return { type: "model" }
    const model = args.join(" ")
    if (!model) return { type: "error", code: "model_requires_name" }
    return { type: "model", model }
  }
  if (name === "provider") {
    const provider = args[0]
    if (!provider) return { type: "error", code: "provider_requires_name" }
    return { type: "provider", name: provider }
  }
  if (name === "max-tokens" || name === "max_tokens") {
    const value = parseOptionalPositiveInteger(args[0])
    if (value === "reset") return { type: "maxTokens" }
    return value ? { type: "maxTokens", value } : { type: "error", code: "max_tokens_requires_value" }
  }
  if (name === "max-steps" || name === "max_steps") {
    const value = parseOptionalPositiveInteger(args[0])
    if (value === "reset") return { type: "maxSteps" }
    return value ? { type: "maxSteps", value } : { type: "error", code: "max_steps_requires_value" }
  }
  if (name === "effort") {
    const value = args[0]?.toLowerCase()
    return value ? { type: "effort", value } : { type: "error", code: "effort_requires_value" }
  }
  if (name === "lang") {
    return args[0] ? { type: "lang", value: args[0] } : { type: "lang" }
  }
  if (name === "thinking" || name === "thingking") {
    const value = args[0]?.toLowerCase()
    if (value !== "on" && value !== "off") return { type: "error", code: "thinking_requires_value" }
    return { type: "thinking", value, aliasUsed: name === "thingking" }
  }
  return { type: "unknown", name: rawName }
}

function parseOptionalPositiveInteger(value: string | undefined) {
  if (value === "reset" || value === "default" || value === "clear") return "reset" as const
  const parsed = Number(value)
  return value && Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

export function slashHelpText(language: UiLanguage = "en") {
  return uiText(language).helpText
}
