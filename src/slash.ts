export type SlashCommand =
  | { type: "prompt"; text: string }
  | { type: "help" }
  | { type: "settings" }
  | { type: "sessions" }
  | { type: "image"; action: "add"; value: string }
  | { type: "image"; action: "clear" }
  | { type: "skill"; action: "list" }
  | { type: "skill"; action: "use"; name: string }
  | { type: "skill"; action: "remove"; name: string }
  | { type: "skill"; action: "clear" }
  | { type: "model"; provider: string; model?: string }
  | { type: "effort"; value: string }
  | { type: "thinking"; value: "on" | "off"; aliasUsed?: boolean }
  | { type: "unknown"; name: string }
  | { type: "error"; message: string }

export function parseSlashCommand(input: string): SlashCommand {
  if (!input.startsWith("/")) return { type: "prompt", text: input }
  if (input.startsWith("//")) return { type: "prompt", text: input.slice(1) }
  const trimmed = input.trim()
  const [rawName = "", ...args] = trimmed.slice(1).split(/\s+/)
  const name = rawName.toLowerCase()
  if (!name) return { type: "help" }
  if (name === "help") return { type: "help" }
  if (name === "settings") return { type: "settings" }
  if (name === "sessions" || name === "session") return { type: "sessions" }
  if (name === "image") {
    if (args[0]?.toLowerCase() === "clear") return { type: "image", action: "clear" }
    const value = args.join(" ")
    return value ? { type: "image", action: "add", value } : { type: "error", message: "/image requires a path or URL" }
  }
  if (name === "skill") {
    const action = args[0]?.toLowerCase()
    if (!action || action === "list") return { type: "skill", action: "list" }
    if (action === "clear") return { type: "skill", action: "clear" }
    if (action === "remove") {
      const skillName = args.slice(1).join(" ")
      return skillName ? { type: "skill", action: "remove", name: skillName } : { type: "error", message: "/skill remove requires a skill name" }
    }
    if (action === "use") {
      const skillName = args.slice(1).join(" ")
      return skillName ? { type: "skill", action: "use", name: skillName } : { type: "error", message: "/skill use requires a skill name" }
    }
    return { type: "skill", action: "use", name: args.join(" ") }
  }
  if (name === "model") {
    const provider = args[0]
    if (!provider) return { type: "error", message: "/model requires a provider name" }
    return { type: "model", provider, model: args[1] }
  }
  if (name === "effort") {
    const value = args[0]?.toLowerCase()
    return value ? { type: "effort", value } : { type: "error", message: "/effort requires low, medium, high, or max" }
  }
  if (name === "thinking" || name === "thingking") {
    const value = args[0]?.toLowerCase()
    if (value !== "on" && value !== "off") return { type: "error", message: "/thinking requires on or off" }
    return { type: "thinking", value, aliasUsed: name === "thingking" }
  }
  return { type: "unknown", name: rawName }
}

export function slashHelpText() {
  return [
    "Commands:",
    "  /image <path-or-url>    attach an image to the next prompt",
    "  /image clear            clear pending images",
    "  /skill list             list available skills",
    "  /skill use <name>       keep a skill active for this session",
    "  /skill remove <name>    remove one active skill",
    "  /skill clear            clear active skills",
    "  /model <provider> [id]  switch provider/model",
    "  /effort <level>         set thinking strength: low, medium, high, max",
    "  /thinking on|off        enable or disable model thinking",
    "  /settings               show current session settings",
    "  /sessions               list saved sessions",
    "  //text                  send /text as a normal prompt",
  ].join("\n")
}
