import { describe, expect, test } from "bun:test"
import { TuiRenderer } from "../../src/ui/tui"

describe("tui renderer", () => {
  test("renders session context, command bar, timeline events, and status updates", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false, columns: 88 }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
      session: "demo",
    })

    renderer.slashCommand("settings")
    renderer.panel("Settings", "provider: fake")
    renderer.event({ type: "run_start", mode: "build", provider: "fake" })
    renderer.event({ type: "text_delta", text: "Done." })
    renderer.event({ type: "run_done", status: "completed" })
    renderer.finish()

    expect(output).toContain("EasyCode TUI")
    expect(output).toContain("session=demo")
    expect(output).toContain("/help /settings /sessions")
    expect(output).toContain("[status] /settings")
    expect(output).toContain("[Settings]")
    expect(output).toContain("● Model")
    expect(output).toContain("● Answer")
    expect(output).toContain("Done.")
    expect(output).toContain("[status] completed")
  })

  test("formats permission and plan approval prompts without bypassing caller input handling", () => {
    let output = ""
    const renderer = new TuiRenderer({ write: (text) => { output += text }, isTTY: false }, {
      root: "/tmp/project",
      mode: "build",
      provider: "fake",
    })

    const prompt = renderer.permissionPrompt({ id: "p1", permission: "bash", patterns: ["git status"], always: ["git status"], metadata: {} }, "Allow bash?")

    expect(prompt).toContain("[Permission]")
    expect(prompt).toContain("Allow bash?")
    expect(renderer.planApprovalPrompt()).toContain("[Plan]")
    expect(output).toContain("[status] permission: bash")
    expect(output).toContain("[status] plan approval")
  })
})
