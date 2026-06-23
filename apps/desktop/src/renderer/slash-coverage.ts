export type DesktopSlashCoverage = {
  id: string
  slash: string
  example: string
  surface: DesktopSlashSurface
  uiPath: string
  quickCommand?: DesktopQuickSlashCommand
}

export type DesktopSlashSurface = "settings-rail" | "workspace-sidebar" | "composer" | "top-bar"

export type DesktopQuickSlashCommand = {
  label: string
  command: string
  enabledWhileRunning?: boolean
}

export const requiredDesktopSlashCommands = [
  "/help",
  "/settings",
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
  "/thinking",
  "/lang",
  "/plan",
  "/goal",
  "/cancel",
] as const

export const desktopSlashCoverage: DesktopSlashCoverage[] = [
  { id: "help", slash: "/help", example: "/help", surface: "settings-rail", uiPath: "Settings rail > Commands > Help", quickCommand: { label: "Help", command: "/help" } },
  { id: "settings", slash: "/settings", example: "/settings", surface: "settings-rail", uiPath: "Settings rail > Commands > Settings", quickCommand: { label: "Settings", command: "/settings" } },
  { id: "sessions", slash: "/sessions", example: "/sessions", surface: "settings-rail", uiPath: "Settings rail > Commands > Sessions", quickCommand: { label: "Sessions", command: "/sessions" } },
  { id: "session", slash: "/session switch <id>", example: "/session switch default", surface: "workspace-sidebar", uiPath: "Workspace sidebar > Sessions list switch/delete buttons" },
  { id: "image", slash: "/image <path-or-url>", example: "/image clear", surface: "composer", uiPath: "Composer > Add files / Clear all attachments", quickCommand: { label: "Clear Images", command: "/image clear" } },
  { id: "file", slash: "/file <path>", example: "/file clear", surface: "composer", uiPath: "Composer > Add files / Clear all attachments", quickCommand: { label: "Clear Files", command: "/file clear" } },
  { id: "skill", slash: "/skill use <name>", example: "/skill list", surface: "settings-rail", uiPath: "Settings rail > Skills panel", quickCommand: { label: "List Skills", command: "/skill list" } },
  { id: "model", slash: "/model <name|reset>", example: "/model reset", surface: "settings-rail", uiPath: "Settings rail > Environment > Model", quickCommand: { label: "Reset Model", command: "/model reset" } },
  { id: "provider", slash: "/provider <name>", example: "/provider deepseek", surface: "settings-rail", uiPath: "Settings rail > Environment > Provider" },
  { id: "max-tokens", slash: "/max-tokens <n|reset>", example: "/max-tokens 64000", surface: "settings-rail", uiPath: "Settings rail > Run > Max Tokens", quickCommand: { label: "Reset Tokens", command: "/max-tokens reset" } },
  { id: "max-steps", slash: "/max-steps <n|reset>", example: "/max-steps 24", surface: "settings-rail", uiPath: "Settings rail > Run > Max Steps", quickCommand: { label: "Reset Steps", command: "/max-steps reset" } },
  { id: "effort", slash: "/effort <level>", example: "/effort high", surface: "settings-rail", uiPath: "Settings rail > Environment > Effort" },
  { id: "thinking", slash: "/thinking on|off", example: "/thinking on", surface: "settings-rail", uiPath: "Settings rail > Environment > Thinking" },
  { id: "lang", slash: "/lang <code>", example: "/lang en", surface: "settings-rail", uiPath: "Settings rail > Environment > Language", quickCommand: { label: "Language Status", command: "/lang" } },
  { id: "plan", slash: "/plan <request>", example: "/plan fix tests", surface: "composer", uiPath: "Composer > Plan mode / Settings rail > Plan panel" },
  { id: "goal", slash: "/goal <objective>", example: "/goal ship desktop gui", surface: "composer", uiPath: "Composer > Goal mode / Settings rail > Goal panel", quickCommand: { label: "Goal Status", command: "/goal status" } },
  { id: "cancel", slash: "/cancel", example: "/cancel", surface: "top-bar", uiPath: "Top bar > Cancel / Composer cancel input", quickCommand: { label: "Cancel", command: "/cancel", enabledWhileRunning: true } },
]

export const desktopQuickSlashCommands = desktopSlashCoverage.flatMap((entry) => entry.quickCommand ? [entry.quickCommand] : [])

export function canRunDesktopQuickSlashCommand(command: DesktopQuickSlashCommand, running: boolean) {
  return !running || command.enabledWhileRunning === true
}

export function missingDesktopSlashCoverage(required = requiredDesktopSlashCommands, coverage = desktopSlashCoverage) {
  return required.filter((command) => !coverage.some((entry) => entry.slash === command || entry.slash.startsWith(`${command} `)))
}
