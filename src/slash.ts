import { uiText, type SlashErrorCode, type UiLanguage } from "./i18n"

export type SlashCommand =
  | { type: "prompt"; text: string }
  | { type: "help" }
  | { type: "settings" }
  | { type: "goal"; action: "start"; objective: string }
  | { type: "goal"; action: "status" | "pause" | "resume" | "clear" }
  | { type: "sessions" }
  | { type: "session"; action: "switch" | "delete"; target: string }
  | { type: "image"; action: "add"; value: string }
  | { type: "image"; action: "clear" }
  | { type: "skill"; action: "list" }
  | { type: "skill"; action: "use"; name: string }
  | { type: "skill"; action: "remove"; name: string }
  | { type: "skill"; action: "clear" }
  | { type: "model"; model: string }
  | { type: "provider"; name: string }
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
    const model = args.join(" ")
    if (!model) return { type: "error", code: "model_requires_name" }
    return { type: "model", model }
  }
  if (name === "provider") {
    const provider = args[0]
    if (!provider) return { type: "error", code: "provider_requires_name" }
    return { type: "provider", name: provider }
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

export function slashHelpText(language: UiLanguage = "en") {
  return uiText(language).helpText
}
