import { describe, expect, test } from "bun:test"
import { canRunDesktopQuickSlashCommand, desktopQuickSlashCommands, desktopSlashCoverage, missingDesktopSlashCoverage, requiredDesktopSlashCommands } from "../../apps/desktop/src/renderer/slash-coverage"
import { canonicalSlashCommandNames, parseSlashCommand, type SlashCommand } from "../../src/slash"

type DesktopRequiredSlashCommand = typeof requiredDesktopSlashCommands[number]
type ParserSlashCommand =
  | Exclude<SlashCommand["type"], "prompt" | "unknown" | "error" | "maxTokens" | "maxSteps">
  | "max-tokens"
  | "max-steps"
type ParserSlashName = `/${ParserSlashCommand}`
type AssertNever<T extends never> = T
type _DesktopCoversEveryParserSlash = AssertNever<Exclude<ParserSlashName, DesktopRequiredSlashCommand>>
type _DesktopDoesNotListUnknownParserSlash = AssertNever<Exclude<DesktopRequiredSlashCommand, ParserSlashName>>

describe("desktop slash coverage", () => {
  test("tracks the canonical CLI slash command set", () => {
    expect([...requiredDesktopSlashCommands].sort()).toEqual([...canonicalSlashCommandNames].sort())
  })

  test("covers every required CLI slash command with a GUI path", () => {
    expect(missingDesktopSlashCoverage()).toEqual([])
    for (const required of requiredDesktopSlashCommands) {
      const coverage = desktopSlashCoverage.find((entry) => entry.slash === required || entry.slash.startsWith(`${required} `))
      expect(coverage, required).toBeTruthy()
      if (!coverage) throw new Error(`Missing desktop slash coverage for ${required}`)
      expect(coverage.uiPath).toBeTruthy()
      expect(["settings-rail", "workspace-sidebar", "composer", "top-bar"]).toContain(coverage.surface)
    }
  })

  test("binds required slash commands to concrete desktop UI surfaces", () => {
    const surfaceById = new Map(desktopSlashCoverage.map((entry) => [entry.id, entry.surface]))

    expect(surfaceById.get("session")).toBe("workspace-sidebar")
    expect(surfaceById.get("image")).toBe("composer")
    expect(surfaceById.get("file")).toBe("composer")
    expect(surfaceById.get("plan")).toBe("composer")
    expect(surfaceById.get("goal")).toBe("composer")
    expect(surfaceById.get("cancel")).toBe("top-bar")
    for (const id of ["help", "settings", "sessions", "skill", "model", "provider", "max-tokens", "max-steps", "effort", "thinking", "lang"]) {
      expect(surfaceById.get(id)).toBe("settings-rail")
    }
  })

  test("uses slash examples that the shared parser recognizes", () => {
    for (const entry of desktopSlashCoverage) {
      const parsed = parseSlashCommand(entry.example)
      expect(parsed.type).not.toBe("unknown")
      expect(parsed.type).not.toBe("error")
    }
  })

  test("renders quick command buttons through the shared coverage table", () => {
    expect(desktopQuickSlashCommands).toEqual([
      { label: "Help", command: "/help" },
      { label: "Settings", command: "/settings" },
      { label: "Sessions", command: "/sessions" },
      { label: "Clear Images", command: "/image clear" },
      { label: "Clear Files", command: "/file clear" },
      { label: "List Skills", command: "/skill list" },
      { label: "Reset Model", command: "/model reset" },
      { label: "Reset Tokens", command: "/max-tokens reset" },
      { label: "Reset Steps", command: "/max-steps reset" },
      { label: "Language Status", command: "/lang" },
      { label: "Goal Status", command: "/goal status" },
      { label: "Cancel", command: "/cancel", enabledWhileRunning: true },
    ])
    for (const command of desktopQuickSlashCommands) {
      const parsed = parseSlashCommand(command.command)
      expect(parsed.type).not.toBe("unknown")
      expect(parsed.type).not.toBe("error")
    }
  })

  test("keeps only explicit quick commands available while a run is active", () => {
    expect(desktopQuickSlashCommands.map((command) => [command.command, canRunDesktopQuickSlashCommand(command, false)])).toEqual(
      desktopQuickSlashCommands.map((command) => [command.command, true]),
    )

    expect(desktopQuickSlashCommands
      .filter((command) => canRunDesktopQuickSlashCommand(command, true))
      .map((command) => command.command)).toEqual(["/cancel"])
  })
})
