import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { normalizeSettings, normalizeSettingsForStorage } from "../../apps/desktop/src/main/settings-normalize"
import { applyAttachmentAction, pickedFileSlashCommands, type DesktopAttachment } from "../../apps/desktop/src/renderer/attachment-state"
import { permissionRequestPresentation } from "../../apps/desktop/src/renderer/permission-state"
import { createQueuedRunInput, dequeueQueuedRunInput, shouldQueueRunInput } from "../../apps/desktop/src/renderer/run-queue"
import { desktopConfigCommand, desktopConfigSettingKeys, type DesktopConfigSettingKey, type DesktopConfigSettingValue } from "../../apps/desktop/src/renderer/settings-commands"
import { draftSessionPromptPlan } from "../../apps/desktop/src/renderer/session-workspace-state"
import { canRunDesktopQuickSlashCommand, desktopQuickSlashCommands, desktopSlashCoverage } from "../../apps/desktop/src/renderer/slash-coverage"
import { PlanTracker, planLedgerSubjects } from "../../src/agent/planner"
import { ContextManager } from "../../src/context"
import { createGoalState, goalLedgerSubjects, writeGoalState } from "../../src/goal"
import { textMessage, type MessagePart, type ToolResultPart } from "../../src/message"
import { FakeProvider } from "../../src/provider"
import { SessionStore } from "../../src/session"
import { defaultSessionSettings, maxSessionSteps, maxSessionTokens } from "../../src/settings"
import { SidecarService, sidecarProtocolVersion, type SidecarEventEnvelope } from "../../src/sidecar"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "easycode-sidecar-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await mkdir(path.join(root, "test"), { recursive: true })
  await Bun.write(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
  await Bun.write(path.join(root, ".env"), "SECRET=x\n")
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "bun test" } }))
  await Bun.write(path.join(root, "test", "add.test.ts"), "import { expect, test } from 'bun:test'\nimport { add } from '../src/add'\ntest('adds', () => expect(add(2, 3)).toBe(5))\n")
  return root
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for sidecar condition")
}

describe("sidecar integration", () => {
  afterEach(() => {
    FakeProvider.clearResponses()
  })

  test("stdio sidecar initializes, lists sessions, and runs a fake-provider prompt", async () => {
    const root = await fixture()
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "sidecar", "--stdio"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TAVILY_API_KEY: "tvly-test" },
    })
    const frames: any[] = []
    void readJsonLines(child.stdout, frames)
    const send = (id: string, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    }

    send("init", "initialize", { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" })
    await waitFor(() => frames.find((frame) => frame.id === "init" && frame.ok))
    send("providers", "listProviders")
    const providers = await waitFor(() => frames.find((frame) => frame.id === "providers" && frame.ok))
    expect(providers.result.providers).toContain("fake")
    send("list", "listSessions")
    await waitFor(() => frames.find((frame) => frame.id === "list" && frame.ok))
    send("run", "runPrompt", { text: "Fix the failing test" })
    await waitFor(() => frames.find((frame) => frame.type === "event" && frame.event?.type === "text_delta"))
    const done = await waitFor(() => frames.find((frame) => frame.id === "run" && frame.ok), 8_000)

    expect(done.result.status).toBe("completed")
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "tool_call")).toBe(true)
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "tool_result")).toBe(true)
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "provider_metrics")).toBe(true)
    expect(frames.some((frame) => frame.type === "event" && frame.event?.type === "run_done")).toBe(true)
    expect(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).exists()).toBe(true)

    send("shutdown", "shutdown")
    child.stdin.end()
    await child.exited
    expect(await new Response(child.stderr).text()).toBe("")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("service emits permission requests and accepts replies", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("custom permission sidecar", (input) => {
      const hasEnvEdit = input.messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.toolName === "edit"))
      return hasEnvEdit
        ? [{ type: "text_delta" as const, text: "Permission path completed." }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_edit_env", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=y" } } }, { type: "done" as const }]
    })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "custom permission sidecar" } })
    const request = await waitFor(() => {
      const event = events.find((item) => item.event.type === "permission_request")
      return event?.event.type === "permission_request" ? event.event.request : undefined
    })
    let settled = false
    pending.finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(settled).toBe(false)
    expect(await Bun.file(path.join(root, ".env")).text()).toContain("SECRET=x")
    await service.handle({ id: "reply", method: "replyPermission", params: { requestId: request.id, reply: "once" } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    await expect(service.handle({ id: "reply-again", method: "replyPermission", params: { requestId: request.id, reply: "once" } })).rejects.toThrow("No pending permission request exists")
    expect(await Bun.file(path.join(root, ".env")).text()).toContain("SECRET=y")
    await rm(root, { recursive: true, force: true })
  })

  test("service resumes Ask permission runs after rejection without applying the operation", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("reject permission sidecar", (input) => {
      const editDenied = input.messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.toolName === "edit" && part.status === "denied"))
      return editDenied
        ? [{ type: "text_delta" as const, text: "Permission rejection handled." }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_reject_env", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=blocked" } } }, { type: "done" as const }]
    })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "reject permission sidecar" } })
    const request = await waitFor(() => {
      const event = events.find((item) => item.event.type === "permission_request")
      return event?.event.type === "permission_request" ? event.event.request : undefined
    })
    await service.handle({ id: "reply", method: "replyPermission", params: { requestId: request.id, reply: "reject" } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    await expect(service.handle({ id: "reply-again", method: "replyPermission", params: { requestId: request.id, reply: "reject" } })).rejects.toThrow("No pending permission request exists")
    expect(String((result as { text?: string }).text)).toContain("Permission rejection handled.")
    expect(events.some((item) => item.event.type === "tool_result" && item.event.toolName === "edit" && item.event.status === "denied")).toBe(true)
    expect(await Bun.file(path.join(root, ".env")).text()).toContain("SECRET=x")
    expect(await Bun.file(path.join(root, ".env")).text()).not.toContain("SECRET=blocked")
    await rm(root, { recursive: true, force: true })
  })

  test("service lists skills and applies selected skills through settings", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo"), { recursive: true })
    const skillFile = path.join(root, ".easycode", "skills", "demo", "SKILL.md")
    await Bun.write(skillFile, "---\nname: demo-skill\ndescription: Demo skill for desktop sidecar tests.\n---\n# Demo\n")
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const listed = await service.handle({ id: "skills", method: "listSkills" }) as { skills: Array<{ id: string; name: string }> }
    expect(listed.skills).toContainEqual(expect.objectContaining({ name: "demo-skill" }))
    const skillId = listed.skills.find((skill) => skill.name === "demo-skill")?.id
    expect(skillId).toBeTruthy()
    if (!skillId) throw new Error("Expected demo skill id")

    await service.handle({ id: "settings", method: "updateSettings", params: { selectedSkills: [skillId], pendingSkillLoads: [skillId] } })
    const settings = await service.handle({ id: "get", method: "getSettings" }) as { settings: { selectedSkills: string[]; pendingSkillLoads: string[] } }
    expect(settings.settings.selectedSkills).toEqual([skillId])
    expect(settings.settings.pendingSkillLoads).toEqual([skillId])

    await service.handle({ id: "clear", method: "updateSettings", params: { selectedSkills: [], pendingSkillLoads: [] } })
    const cleared = await service.handle({ id: "get2", method: "getSettings" }) as { settings: { selectedSkills: string[]; pendingSkillLoads: string[] } }
    expect(cleared.settings.selectedSkills).toEqual([])
    expect(cleared.settings.pendingSkillLoads).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test("service executes slash commands without routing local commands to the agent", async () => {
    const root = await fixture()
    await mkdir(path.join(root, ".easycode", "skills", "demo"), { recursive: true })
    const skillFile = path.join(root, ".easycode", "skills", "demo", "SKILL.md")
    await Bun.write(skillFile, "---\nname: demo-skill\ndescription: Demo skill for slash tests.\n---\n# Demo\n")
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const settings = await service.handle({ id: "settings", method: "executeSlashCommand", params: { text: "/settings", pendingImages: 2, pendingFiles: 1 } }) as { handled: boolean; title: string; text: string }
    expect(settings.handled).toBe(true)
    expect(settings.title).toBe("Settings")
    expect(settings.text).toContain("provider: fake")
    expect(settings.text).toContain("pending images: 2")
    expect(settings.text).toContain("pending files: 1")

    const literal = await service.handle({ id: "literal", method: "executeSlashCommand", params: { text: "//please keep slash" } }) as { handled: boolean; promptText: string }
    expect(literal).toEqual({ handled: false, promptText: "/please keep slash" })

    const model = await service.handle({ id: "model", method: "executeSlashCommand", params: { text: "/model gpt-5.5" } }) as { handled: boolean; settings?: { model?: string } }
    expect(model.handled).toBe(true)
    expect(model.settings?.model).toBe("gpt-5.5")

    const resetModel = await service.handle({ id: "model-reset", method: "executeSlashCommand", params: { text: "/model reset" } }) as { handled: boolean; settings?: { model?: string } }
    expect(resetModel.handled).toBe(true)
    expect(resetModel.settings?.model).toBeUndefined()

    const provider = await service.handle({ id: "provider", method: "executeSlashCommand", params: { text: "/provider deepseek" } }) as { handled: boolean; settings?: { provider: string; model?: string } }
    expect(provider.handled).toBe(true)
    expect(provider.settings?.provider).toBe("deepseek")
    expect(provider.settings?.model).toBeUndefined()

    const previousLang = process.env.EASYCODE_LANG
    const language = await service.handle({ id: "language", method: "executeSlashCommand", params: { text: "/lang zh" } }) as { handled: boolean; settings?: { language: string } }
    expect(language.handled).toBe(true)
    expect(language.settings?.language).toBe("zh")
    expect(process.env.EASYCODE_LANG).toBe(previousLang)

    const thinking = await service.handle({ id: "thinking", method: "executeSlashCommand", params: { text: "/thinking off" } }) as { handled: boolean; settings?: { thinking: boolean } }
    expect(thinking.handled).toBe(true)
    expect(thinking.settings?.thinking).toBe(false)

    const effort = await service.handle({ id: "effort", method: "executeSlashCommand", params: { text: "/effort max" } }) as { handled: boolean; settings?: { effort: string } }
    expect(effort.handled).toBe(true)
    expect(effort.settings?.effort).toBe("max")

    const maxTokens = await service.handle({ id: "max-tokens", method: "executeSlashCommand", params: { text: `/max-tokens ${maxSessionTokens + 1_000}` } }) as { handled: boolean; settings?: { maxTokens?: number } }
    expect(maxTokens.handled).toBe(true)
    expect(maxTokens.settings?.maxTokens).toBe(maxSessionTokens)

    const maxSteps = await service.handle({ id: "max-steps", method: "executeSlashCommand", params: { text: `/max-steps ${maxSessionSteps + 20}` } }) as { handled: boolean; settings?: { maxSteps?: number } }
    expect(maxSteps.handled).toBe(true)
    expect(maxSteps.settings?.maxSteps).toBe(maxSessionSteps)

    const resetTokens = await service.handle({ id: "max-tokens-reset", method: "executeSlashCommand", params: { text: "/max-tokens reset" } }) as { handled: boolean; settings?: { maxTokens?: number } }
    expect(resetTokens.settings?.maxTokens).toBe(defaultSessionSettings("deepseek").maxTokens)

    const resetSteps = await service.handle({ id: "max-steps-reset", method: "executeSlashCommand", params: { text: "/max-steps reset" } }) as { handled: boolean; settings?: { maxSteps?: number } }
    expect(resetSteps.settings?.maxSteps).toBe(defaultSessionSettings("deepseek").maxSteps)

    const skill = await service.handle({ id: "skill", method: "executeSlashCommand", params: { text: "/skill use demo-skill" } }) as { handled: boolean; settings?: { selectedSkills: string[]; pendingSkillLoads: string[] } }
    expect(skill.handled).toBe(true)
    expect(skill.settings?.selectedSkills.some((id) => id.includes("demo"))).toBe(true)
    expect(skill.settings?.pendingSkillLoads).toEqual(skill.settings?.selectedSkills)

    const skillId = skill.settings?.selectedSkills[0]
    expect(skillId).toBeTruthy()
    const removed = await service.handle({ id: "skill-remove", method: "executeSlashCommand", params: { text: `/skill remove ${skillId}` } }) as { handled: boolean; settings?: { selectedSkills: string[]; pendingSkillLoads: string[] } }
    expect(removed.handled).toBe(true)
    expect(removed.settings?.selectedSkills).toEqual([])
    expect(removed.settings?.pendingSkillLoads).toEqual([])

    await service.handle({ id: "skill-again", method: "executeSlashCommand", params: { text: "/skill use demo-skill" } })
    const cleared = await service.handle({ id: "clear", method: "executeSlashCommand", params: { text: "/skill clear" } }) as { settings?: { selectedSkills: string[]; pendingSkillLoads: string[] } }
    expect(cleared.settings?.selectedSkills).toEqual([])
    expect(cleared.settings?.pendingSkillLoads).toEqual([])
    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "default" } }) as { settings: { provider?: string; model?: string; language?: string; thinking?: boolean; effort?: string; maxTokens?: number; maxSteps?: number; selectedSkills?: string[]; pendingSkillLoads?: string[] } }
    expect(loaded.settings.provider).toBe("deepseek")
    expect(loaded.settings.model).toBeUndefined()
    expect(loaded.settings.language).toBe("zh")
    expect(loaded.settings.thinking).toBe(false)
    expect(loaded.settings.effort).toBe("max")
    expect(loaded.settings.maxTokens).toBe(defaultSessionSettings("deepseek").maxTokens)
    expect(loaded.settings.maxSteps).toBe(defaultSessionSettings("deepseek").maxSteps)
    expect(loaded.settings.selectedSkills).toEqual([])
    expect(loaded.settings.pendingSkillLoads).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test("service executes every desktop quick slash command as a real sidecar command", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    for (const quick of desktopQuickSlashCommands) {
      const result = await service.handle({ id: quick.command, method: "executeSlashCommand", params: { text: quick.command } }) as { handled: boolean; text?: string; title?: string }
      expect(result.handled, quick.command).toBe(true)
      expect(result.title, quick.command).toBeTruthy()
      expect(result.text, quick.command).toBeTruthy()
    }
    await rm(root, { recursive: true, force: true })
  })

  test("service executes every desktop slash coverage example through the sidecar", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    for (const entry of desktopSlashCoverage) {
      const result = await service.handle({ id: entry.id, method: "executeSlashCommand", params: { text: entry.example } }) as { handled: boolean; mode?: string; promptText?: string; title?: string; text?: string }
      expect(entry.surface, entry.example).toBeTruthy()
      expect(entry.uiPath, entry.example).toContain(">")
      if (entry.id === "plan" || entry.id === "goal") {
        expect(result.handled, entry.example).toBe(false)
        expect(result.mode, entry.example).toBe(entry.id)
        expect(result.promptText, entry.example).toBeTruthy()
        continue
      }
      expect(result.handled, entry.example).toBe(true)
      expect(result.title, entry.example).toBeTruthy()
      expect(result.text, entry.example).toBeTruthy()
    }
    await rm(root, { recursive: true, force: true })
  })

  test("service persists slash setting changes and saves current session before slash session switch", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    const store = new SessionStore(root)
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    await service.handle({ id: "model", method: "executeSlashCommand", params: { text: "/model first-session-model" } })
    const savedDefault = await store.load("default")
    if (!savedDefault?.settings) throw new Error("Expected default session settings to be persisted")
    expect(savedDefault.settings.model).toBe("first-session-model")

    await service.handle({ id: "switch", method: "executeSlashCommand", params: { text: "/session switch scratch-session" } })
    await service.handle({ id: "scratch-model", method: "executeSlashCommand", params: { text: "/model scratch-session-model" } })
    const reloadedDefault = await store.load("default")
    const savedScratch = await store.load("scratch-session")

    if (!reloadedDefault?.settings) throw new Error("Expected default session settings after switching")
    if (!savedScratch?.settings) throw new Error("Expected scratch session settings after slash model")
    expect(reloadedDefault.settings.model).toBe("first-session-model")
    expect(savedScratch.settings.model).toBe("scratch-session-model")
    await rm(root, { recursive: true, force: true })
  })

  test("desktop config commands persist through sidecar slash settings into the session store", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "desktop-config" } })

    await service.handle({ id: "provider", method: "executeSlashCommand", params: { text: desktopConfigCommand("provider", "deepseek") } })
    await service.handle({ id: "model", method: "executeSlashCommand", params: { text: desktopConfigCommand("model", "deepseek-v4-flash") } })
    await service.handle({ id: "language", method: "executeSlashCommand", params: { text: desktopConfigCommand("language", "zh") } })
    await service.handle({ id: "thinking", method: "executeSlashCommand", params: { text: desktopConfigCommand("thinking", false) } })
    await service.handle({ id: "effort", method: "executeSlashCommand", params: { text: desktopConfigCommand("effort", "max") } })
    await service.handle({ id: "max-tokens", method: "executeSlashCommand", params: { text: desktopConfigCommand("maxTokens", 12345) } })
    await service.handle({ id: "max-steps", method: "executeSlashCommand", params: { text: desktopConfigCommand("maxSteps", 12) } })

    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "desktop-config" } }) as { settings: Record<string, unknown> }
    expect(loaded.settings).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      language: "zh",
      thinking: false,
      effort: "max",
      maxTokens: 12345,
      maxSteps: 12,
    })
    await rm(root, { recursive: true, force: true })
  })

  test("desktop config commands round-trip every UI control through sidecar settings and session persistence", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "desktop-config-roundtrip" } })

    const values: DesktopConfigSettingValue = {
      provider: "fake",
      model: "fake-custom-model",
      language: "de",
      thinking: false,
      effort: "max",
      maxTokens: 23456,
      maxSteps: 14,
    }

    for (const key of desktopConfigSettingKeys) {
      const result = await service.handle({
        id: `config-${key}`,
        method: "executeSlashCommand",
        params: { text: desktopConfigCommand(key, values[key] as never) },
      }) as { handled: boolean; settings?: Partial<DesktopConfigSettingValue> }
      const live = await service.handle({ id: `live-${key}`, method: "getSettings" }) as { settings: Record<string, unknown> }

      expect(result.handled).toBe(true)
      expect(live.settings[key]).toBe(values[key])
    }

    const live = await service.handle({ id: "live-final", method: "getSettings" }) as { settings: Record<DesktopConfigSettingKey, unknown> }
    const loaded = await service.handle({ id: "load-final", method: "loadSession", params: { session: "desktop-config-roundtrip" } }) as { settings: Record<DesktopConfigSettingKey, unknown> }
    for (const key of desktopConfigSettingKeys) {
      expect(live.settings[key]).toBe(values[key])
      expect(loaded.settings[key]).toBe(values[key])
    }
    await rm(root, { recursive: true, force: true })
  })

  test("desktop config commands apply every setting immediately to sidecar settings output", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "desktop-config-live" } })
    const settingsText = async () => {
      const result = await service.handle({ id: crypto.randomUUID(), method: "executeSlashCommand", params: { text: "/settings" } }) as { text: string }
      return result.text
    }

    await service.handle({ id: "provider", method: "executeSlashCommand", params: { text: desktopConfigCommand("provider", "deepseek") } })
    expect(await settingsText()).toContain("provider: deepseek")

    await service.handle({ id: "model", method: "executeSlashCommand", params: { text: desktopConfigCommand("model", "deepseek-v4-flash") } })
    expect(await settingsText()).toContain("model: deepseek-v4-flash")

    await service.handle({ id: "thinking", method: "executeSlashCommand", params: { text: desktopConfigCommand("thinking", false) } })
    expect(await settingsText()).toContain("thinking: off")

    await service.handle({ id: "effort", method: "executeSlashCommand", params: { text: desktopConfigCommand("effort", "max") } })
    expect(await settingsText()).toContain("effort: max")

    await service.handle({ id: "max-tokens", method: "executeSlashCommand", params: { text: desktopConfigCommand("maxTokens", 12345) } })
    expect(await settingsText()).toContain("maxTokens: 12345")

    await service.handle({ id: "max-steps", method: "executeSlashCommand", params: { text: desktopConfigCommand("maxSteps", 12) } })
    expect(await settingsText()).toContain("maxSteps: 12")

    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "desktop-config-live" } }) as { settings: Record<string, unknown> }
    expect(loaded.settings).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: false,
      effort: "max",
      maxTokens: 12345,
      maxSteps: 12,
    })
    await rm(root, { recursive: true, force: true })
  })

  test("desktop config commands apply language immediately to sidecar copy and persist it", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "desktop-language" } })

    const language = await service.handle({ id: "language", method: "executeSlashCommand", params: { text: desktopConfigCommand("language", "zh") } }) as { handled: boolean; title: string; text: string; settings?: { language?: string } }
    const settings = await service.handle({ id: "settings", method: "executeSlashCommand", params: { text: "/settings" } }) as { handled: boolean; title: string; text: string }
    const help = await service.handle({ id: "help", method: "executeSlashCommand", params: { text: "/help" } }) as { handled: boolean; title: string; text: string }
    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "desktop-language" } }) as { settings: { language?: string } }

    expect(language.handled).toBe(true)
    expect(language.title).toBe("语言")
    expect(language.text).toContain("界面语言已切换为 zh (中文)")
    expect(language.settings?.language).toBe("zh")
    expect(settings.title).toBe("设置")
    expect(settings.text).toContain("language: zh")
    expect(help.title).toBe("帮助")
    expect(help.text).toContain("/settings               查看当前会话设置")
    expect(loaded.settings.language).toBe("zh")
    await rm(root, { recursive: true, force: true })
  })

  test("service maps slash plan and goal commands to real run modes", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const plan = await service.handle({ id: "plan", method: "executeSlashCommand", params: { text: "/plan fix tests" } }) as { handled: boolean; promptText: string; mode?: string }
    expect(plan).toEqual({ handled: false, promptText: "fix tests", mode: "plan" })

    const goal = await service.handle({ id: "goal", method: "executeSlashCommand", params: { text: "/goal ship desktop gui" } }) as { handled: boolean; promptText: string; mode?: string }
    expect(goal).toEqual({ handled: false, promptText: "ship desktop gui", mode: "goal" })
    await rm(root, { recursive: true, force: true })
  })

  test("service switches to a new session through slash command like the CLI", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const switched = await service.handle({ id: "switch", method: "executeSlashCommand", params: { text: "/session switch scratch-session" } }) as { handled: boolean; session?: string; text: string }
    const settings = await service.handle({ id: "settings", method: "getSettings" }) as { session: string }
    const listed = await service.handle({ id: "list", method: "listSessions" }) as { sessions: Array<{ id: string }> }

    expect(switched.handled).toBe(true)
    expect(switched.session).toBe("scratch-session")
    expect(switched.text).toContain("scratch-session")
    expect(settings.session).toBe("scratch-session")
    expect(listed.sessions.some((session) => session.id === "scratch-session")).toBe(true)
    expect(events.some((item) => item.event.type === "session_changed" && item.event.session === "scratch-session")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service deleteSession moves current session when deleting the active session", async () => {
    const root = await fixture()
    const store = new SessionStore(root)
    const oldContext = new ContextManager()
    oldContext.add(textMessage("user", "old active"))
    const nextContext = new ContextManager()
    nextContext.add(textMessage("user", "next active"))
    await store.save("old-active", oldContext)
    await store.save("next-active", nextContext)
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "old-active" } })

    const deleted = await service.handle({ id: "delete", method: "deleteSession", params: { session: "old-active" } }) as { existed: boolean; currentSession?: string }
    const listed = await service.handle({ id: "list", method: "listSessions" }) as { currentSession: string; sessions: Array<{ id: string }> }

    expect(deleted.existed).toBe(true)
    expect(deleted.currentSession).toBe("next-active")
    expect(listed.currentSession).toBe("next-active")
    expect(listed.sessions.some((session) => session.id === "old-active")).toBe(false)
    expect(events.some((item) => item.event.type === "session_changed" && item.event.session === "next-active")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service slash session delete active session matches CLI switching semantics", async () => {
    const root = await fixture()
    const store = new SessionStore(root)
    const oldContext = new ContextManager()
    oldContext.add(textMessage("user", "old active"))
    const nextContext = new ContextManager()
    nextContext.add(textMessage("user", "next active"))
    await store.save("old-active", oldContext, { ...defaultSessionSettings("fake"), model: "old-model" })
    await store.save("next-active", nextContext, { ...defaultSessionSettings("fake"), model: "next-model" })
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "old-active" } })

    const deleted = await service.handle({ id: "slash-delete", method: "executeSlashCommand", params: { text: "/session delete old-active" } }) as { handled: boolean; session?: string; settings?: { model?: string }; text: string }
    const listed = await service.handle({ id: "list", method: "listSessions" }) as { currentSession: string; sessions: Array<{ id: string }> }
    const current = await service.handle({ id: "settings", method: "getSettings" }) as { session: string; settings: { model?: string } }

    expect(deleted.handled).toBe(true)
    expect(deleted.session).toBe("next-active")
    expect(deleted.settings?.model).toBe("next-model")
    expect(deleted.text).toContain("Deleted session: old-active")
    expect(deleted.text).toContain("Switched to next-active")
    expect(listed.currentSession).toBe("next-active")
    expect(listed.sessions.some((session) => session.id === "old-active")).toBe(false)
    expect(current.session).toBe("next-active")
    expect(current.settings.model).toBe("next-model")
    expect(events.some((item) => item.event.type === "session_changed" && item.event.session === "next-active")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service deleteSession falls back to persisted default when deleting the only active session", async () => {
    const root = await fixture()
    const store = new SessionStore(root)
    const onlyContext = new ContextManager()
    onlyContext.add(textMessage("user", "only active"))
    await store.save("only-active", onlyContext)
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "only-active" } })

    const deleted = await service.handle({ id: "delete", method: "deleteSession", params: { session: "only-active" } }) as { existed: boolean; currentSession?: string }
    const listed = await service.handle({ id: "list", method: "listSessions" }) as { currentSession: string; sessions: Array<{ id: string; messageCount: number }> }
    const loadedDefault = await service.handle({ id: "load-default", method: "loadSession", params: { session: "default" } }) as unknown as { settings: { provider: string }; messages: unknown[] }

    expect(deleted.existed).toBe(true)
    expect(deleted.currentSession).toBe("default")
    expect(listed.currentSession).toBe("default")
    expect(listed.sessions).toContainEqual(expect.objectContaining({ id: "default", messageCount: 0 }))
    expect(loadedDefault.settings.provider).toBe("fake")
    expect(loadedDefault.messages).toEqual([])
    expect(events.some((item) => item.event.type === "session_changed" && item.event.session === "default")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service initializes separate workspace roots with isolated default sessions", async () => {
    const rootA = await fixture()
    const rootB = await fixture()
    const contextA = new ContextManager()
    contextA.add(textMessage("user", "workspace a default"))
    const contextB = new ContextManager()
    contextB.add(textMessage("user", "workspace b default"))
    const scratchB = new ContextManager()
    scratchB.add(textMessage("user", "workspace b scratch"))
    await new SessionStore(rootA).save("default", contextA)
    await new SessionStore(rootB).save("default", contextB)
    await new SessionStore(rootB).save("scratch", scratchB)
    const service = new SidecarService(() => {})

    await service.handle({ id: "init-a", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root: rootA, provider: "fake", session: "default" } })
    const listedA = await service.handle({ id: "list-a", method: "listSessions" }) as { currentSession: string; sessions: Array<{ id: string }> }
    const loadedA = await service.handle({ id: "load-a", method: "loadSession", params: { session: "default" } }) as unknown as { messages: unknown[] }

    await service.handle({ id: "init-b", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root: rootB, provider: "fake", session: "default" } })
    const listedB = await service.handle({ id: "list-b", method: "listSessions" }) as { currentSession: string; sessions: Array<{ id: string }> }
    const loadedB = await service.handle({ id: "load-b", method: "loadSession", params: { session: "default" } }) as unknown as { messages: unknown[] }

    expect(listedA.currentSession).toBe("default")
    expect(listedA.sessions.map((session) => session.id)).toEqual(["default"])
    expect(JSON.stringify(loadedA.messages)).toContain("workspace a default")
    expect(listedB.currentSession).toBe("default")
    expect(listedB.sessions.map((session) => session.id).sort()).toEqual(["default", "scratch"])
    expect(JSON.stringify(loadedB.messages)).toContain("workspace b default")
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  })

  test("separate workspace sidecar instances can run independently", async () => {
    const rootA = await fixture()
    const rootB = await fixture()
    const serviceA = new SidecarService(() => {})
    const serviceB = new SidecarService(() => {})
    await serviceA.handle({ id: "init-a", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root: rootA, provider: "fake", session: "default" } })
    await serviceB.handle({ id: "init-b", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root: rootB, provider: "fake", session: "default" } })

    let aSettled = false
    const runA = serviceA.handle({ id: "run-a", method: "runPrompt", params: { text: "delayed workspace a" } }).finally(() => {
      aSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const runB = await serviceB.handle({ id: "run-b", method: "runPrompt", params: { text: "queued-ok workspace b" } }) as { status: string }

    expect(runB.status).toBe("completed")
    expect(aSettled).toBe(false)
    expect(await runA).toMatchObject({ status: "completed" })
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  })

  test("separate workspace sidecar instances keep pending runs and persisted sessions isolated", async () => {
    const rootA = await fixture()
    const rootB = await fixture()
    const eventsA: SidecarEventEnvelope[] = []
    const eventsB: SidecarEventEnvelope[] = []
    const serviceA = new SidecarService((event) => eventsA.push(event))
    const serviceB = new SidecarService((event) => eventsB.push(event))
    await serviceA.handle({ id: "init-a", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root: rootA, provider: "fake", session: "default" } })
    await serviceB.handle({ id: "init-b", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root: rootB, provider: "fake", session: "default" } })

    FakeProvider.registerResponse((input) => input.prompt.includes("workspace-a-pending-permission"), (input) => {
      const editResult = input.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_result" && part.toolName === "edit")
      return editResult
        ? [{ type: "text_delta" as const, text: "Workspace A resumed and persisted." }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_workspace_a_edit", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=workspace-a" } } }, { type: "done" as const }]
    })
    FakeProvider.registerResponse("workspace-b-independent-run", [
      { type: "text_delta" as const, text: "Workspace B completed independently." },
      { type: "done" as const },
    ])

    const pendingA = serviceA.handle({ id: "run-a", method: "runPrompt", params: { text: "workspace-a-pending-permission", permissionMode: "ask" } })
    const requestA = await waitFor(() => {
      const event = eventsA.find((item) => item.event.type === "permission_request")
      return event?.event.type === "permission_request" ? event.event.request : undefined
    })
    let aSettled = false
    pendingA.finally(() => {
      aSettled = true
    })

    const resultB = await serviceB.handle({ id: "run-b", method: "runPrompt", params: { text: "workspace-b-independent-run" } }) as { status: string; text?: string }
    const savedB = await Bun.file(path.join(rootB, ".easycode", "sessions", "default.json")).text()

    expect(resultB.status).toBe("completed")
    expect(resultB.text).toContain("Workspace B completed independently.")
    expect(savedB).toContain("workspace-b-independent-run")
    expect(savedB).toContain("Workspace B completed independently.")
    expect(savedB).not.toContain("workspace-a-pending-permission")
    expect(aSettled).toBe(false)
    expect(await Bun.file(path.join(rootA, ".env")).text()).toContain("SECRET=x")

    await serviceA.handle({ id: "reply-a", method: "replyPermission", params: { requestId: requestA.id, reply: "once" } })
    const resultA = await pendingA as { status: string; text?: string }
    const savedA = await Bun.file(path.join(rootA, ".easycode", "sessions", "default.json")).text()

    expect(resultA.status).toBe("completed")
    expect(resultA.text).toContain("Workspace A resumed and persisted.")
    expect(savedA).toContain("workspace-a-pending-permission")
    expect(savedA).toContain("Workspace A resumed and persisted.")
    expect(savedA).not.toContain("workspace-b-independent-run")
    expect(await Bun.file(path.join(rootA, ".env")).text()).toContain("SECRET=workspace-a")
    expect(eventsB.some((item) => item.event.type === "permission_request")).toBe(false)
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service clears model when desktop sends explicit null over JSON", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", model: "fake-custom-model" } })

    const before = await service.handle({ id: "before", method: "getSettings" }) as { settings: { model?: string } }
    expect(before.settings.model).toBe("fake-custom-model")

    await service.handle({ id: "clear-update", method: "updateSettings", params: { model: null } })
    const afterUpdate = await service.handle({ id: "after-update", method: "getSettings" }) as { settings: { model?: string } }
    expect(afterUpdate.settings.model).toBeUndefined()

    await service.handle({ id: "set-again", method: "updateSettings", params: { model: "fake-custom-model" } })
    await service.handle({ id: "clear-init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", model: null } })
    const afterInitialize = await service.handle({ id: "after-init", method: "getSettings" }) as { settings: { model?: string } }
    expect(afterInitialize.settings.model).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  test("desktop storage preserves sidecar slash model reset across reload with env defaults", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "openai-compatible", model: "custom-model" } })

    const reset = await service.handle({ id: "model-reset", method: "executeSlashCommand", params: { text: "/model reset" } }) as { settings?: { provider: string; model?: string } }
    expect(reset.settings?.provider).toBe("openai-compatible")
    expect(reset.settings?.model).toBeUndefined()

    const { stored } = normalizeSettingsForStorage({ workspaceRoot: root, ...reset.settings })
    const serialized = JSON.parse(JSON.stringify(stored))
    const reloaded = normalizeSettings(serialized, {
      provider: "openai-compatible",
      model: "env-default-model",
    })

    expect(serialized.model).toBe("")
    expect(reloaded.provider).toBe("openai-compatible")
    expect(reloaded.model).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  test("service resets run limits when desktop sends explicit null over JSON", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", maxTokens: 12345, maxSteps: 12 } })

    const before = await service.handle({ id: "before", method: "getSettings" }) as { settings: { maxTokens?: number; maxSteps?: number } }
    expect(before.settings.maxTokens).toBe(12345)
    expect(before.settings.maxSteps).toBe(12)

    await service.handle({ id: "clear-update", method: "updateSettings", params: { maxTokens: null, maxSteps: null } })
    const afterUpdate = await service.handle({ id: "after-update", method: "getSettings" }) as { settings: { maxTokens?: number; maxSteps?: number } }
    expect(afterUpdate.settings.maxTokens).toBe(defaultSessionSettings("fake").maxTokens)
    expect(afterUpdate.settings.maxSteps).toBe(defaultSessionSettings("fake").maxSteps)

    await service.handle({ id: "set-again", method: "updateSettings", params: { maxTokens: 11111, maxSteps: 11 } })
    await service.handle({ id: "clear-init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", maxTokens: null, maxSteps: null } })
    const afterInitialize = await service.handle({ id: "after-init", method: "getSettings" }) as { settings: { maxTokens?: number; maxSteps?: number } }
    expect(afterInitialize.settings.maxTokens).toBe(defaultSessionSettings("fake").maxTokens)
    expect(afterInitialize.settings.maxSteps).toBe(defaultSessionSettings("fake").maxSteps)
    await rm(root, { recursive: true, force: true })
  })

  test("service restores existing session settings through slash session switch", async () => {
    const root = await fixture()
    const store = new SessionStore(root)
    await store.save("configured", new ContextManager(), {
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
      thinking: false,
      effort: "medium",
      selectedSkills: ["demo-skill"],
      pendingSkillLoads: ["demo-skill"],
      maxTokens: 12345,
      maxSteps: 23,
    })
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const switched = await service.handle({ id: "switch", method: "executeSlashCommand", params: { text: "/session switch configured" } }) as { handled: boolean; session?: string; settings?: Record<string, unknown> }
    const settings = await service.handle({ id: "settings", method: "getSettings" }) as { session: string; settings: Record<string, unknown> }

    expect(switched.handled).toBe(true)
    expect(switched.session).toBe("configured")
    expect(settings.session).toBe("configured")
    expect(settings.settings).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
      thinking: false,
      effort: "medium",
      selectedSkills: ["demo-skill"],
      pendingSkillLoads: ["demo-skill"],
      maxTokens: 12345,
      maxSteps: 23,
    })
    await rm(root, { recursive: true, force: true })
  })

  test("service cancels an active run through slash cancel", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("slash cancel waiting permission", () => [
      { type: "tool_call" as const, call: { id: "call_cancel_edit", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=z" } } },
      { type: "done" as const },
    ])

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "slash cancel waiting permission" } })
    await waitFor(() => events.find((item) => item.event.type === "permission_request"))
    const runningCommands = desktopQuickSlashCommands.filter((command) => canRunDesktopQuickSlashCommand(command, true))
    expect(runningCommands.map((command) => command.command)).toEqual(["/cancel"])

    const cancelled = await service.handle({ id: "cancel", method: "executeSlashCommand", params: { text: runningCommands[0].command } }) as { handled: boolean; text: string }
    const result = await pending as { status: string }

    expect(cancelled.handled).toBe(true)
    expect(cancelled.text).toContain("Cancelling")
    expect(result.status).toBe("cancelled")
    await rm(root, { recursive: true, force: true })
  })

  test("service executes local slash commands immediately while renderer keeps run inputs queued", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("local slash while running", (input) => {
      const editDenied = input.messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.toolName === "edit" && part.status === "denied"))
      return editDenied
        ? [{ type: "text_delta" as const, text: "Local slash did not disturb the pending run." }, { type: "done" as const }]
        : [
          { type: "tool_call" as const, call: { id: "call_local_slash_edit", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=z" } } },
          { type: "done" as const },
        ]
    })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "local slash while running" } }) as Promise<{ status: string }>
    let pendingDone = false
    void pending.then(() => {
      pendingDone = true
    })
    const request = await waitFor(() => {
      const event = events.find((item) => item.event.type === "permission_request")
      return event?.event.type === "permission_request" ? event.event.request : undefined
    })

    expect(shouldQueueRunInput("next prompt", true)).toBe(true)
    expect(shouldQueueRunInput("/plan fix tests", true)).toBe(true)
    expect(shouldQueueRunInput("/settings", true)).toBe(false)
    const settings = await service.handle({ id: "settings-while-running", method: "executeSlashCommand", params: { text: "/settings" } }) as { handled: boolean; title: string; text: string }
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(settings.handled).toBe(true)
    expect(settings.title).toContain("Settings")
    expect(pendingDone).toBe(false)

    await service.handle({ id: "reply", method: "replyPermission", params: { requestId: request.id, reply: "reject" } })
    await expect(pending).resolves.toMatchObject({ status: "completed" })
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service accepts a renderer queued plan run after a completed build run", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const first = await service.handle({ id: "first", method: "runPrompt", params: { text: "Fix the failing test" } }) as { status: string }
    expect(first.status).toBe("completed")
    expect(events.some((item) => item.event.type === "run_done" && item.event.status === "completed")).toBe(true)

    events.length = 0
    const queued = createQueuedRunInput({ text: "plan-exit", mode: "plan", permissionMode: "ask", images: [], files: [] }, "queued_plan", Date.now())
    const flushed = dequeueQueuedRunInput([queued], false)
    expect(flushed).toMatchObject({ next: queued, remaining: [] })
    if (!flushed.next) throw new Error("Expected a queued input to flush.")
    const second = service.handle({ id: "second", method: "runPrompt", params: { text: flushed.next.text, mode: flushed.next.mode, permissionMode: flushed.next.permissionMode } })
    const plan = await waitFor(() => events.find((item) => item.event.type === "plan_approval_request"))
    expect(events.some((item) => item.event.type === "run_done")).toBe(false)
    await service.handle({ id: "reply", method: "replyPlan", params: { runId: plan.runId, action: "approve" } })
    const result = await second

    expect(result).toMatchObject({ status: "completed" })
    expect(events.some((item) => item.event.type === "run_done" && item.event.status === "completed")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service accepts a renderer queued plain prompt after a completed build run", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const first = await service.handle({ id: "first", method: "runPrompt", params: { text: "Fix the failing test" } }) as { status: string }
    expect(first.status).toBe("completed")

    FakeProvider.registerResponse("queued plain sidecar", [
      { type: "text_delta" as const, text: "Queued plain prompt completed." },
      { type: "done" as const },
    ])
    const queued = createQueuedRunInput({
      text: "queued plain sidecar",
      mode: "build",
      permissionMode: "ask",
      images: [],
      files: [],
    }, "queued_plain", Date.now())
    const flushed = dequeueQueuedRunInput([queued], false)
    expect(flushed).toMatchObject({ next: queued, remaining: [] })
    if (!flushed.next) throw new Error("Expected a queued plain input to flush.")

    events.length = 0
    const second = await service.handle({ id: "second", method: "runPrompt", params: { text: flushed.next.text, mode: flushed.next.mode, permissionMode: flushed.next.permissionMode } }) as { status: string; text?: string }

    expect(second.status).toBe("completed")
    expect(second.text).toContain("Queued plain prompt completed.")
    expect(events.some((item) => item.event.type === "text_delta" && item.event.text.includes("Queued plain prompt completed."))).toBe(true)
    const saved = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    expect(JSON.stringify(saved.messages)).toContain("queued plain sidecar")
    expect(JSON.stringify(saved.messages)).toContain("Queued plain prompt completed.")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service accepts a renderer queued file attachment run after a completed build run", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    const first = await service.handle({ id: "first", method: "runPrompt", params: { text: "Fix the failing test" } }) as { status: string }
    expect(first.status).toBe("completed")

    FakeProvider.registerResponse((input) => input.prompt.includes("queued attachment sidecar") && input.prompt.includes("<attached_files>") && input.prompt.includes("- src/add.ts"), [
      { type: "text_delta" as const, text: "Queued attached file reference received." },
      { type: "done" as const },
    ])
    const queued = createQueuedRunInput({
      text: "queued attachment sidecar",
      mode: "build",
      permissionMode: "ask",
      images: [],
      files: [path.join(root, "src", "add.ts")],
    }, "queued_file", Date.now())
    const flushed = dequeueQueuedRunInput([queued], false)
    if (!flushed.next) throw new Error("Expected a queued file input to flush.")

    const second = await service.handle({ id: "second", method: "runPrompt", params: { text: flushed.next.text, mode: flushed.next.mode, permissionMode: flushed.next.permissionMode, files: flushed.next.files } }) as { status: string; text?: string }

    expect(second.status).toBe("completed")
    expect(second.text).toContain("Queued attached file reference received.")
    const saved = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    const userText = saved.messages.at(-2)?.parts.find((part: any) => part.type === "text")?.text
    expect(userText).toContain("<attached_files>")
    expect(userText).toContain("- src/add.ts")
    expect(userText).not.toContain(root)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service reports provider readiness without exposing secret values", async () => {
    const root = await fixture()
    const previousOpenAIKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const service = new SidecarService(() => {})
      await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "openai" } })

      const readiness = await service.handle({ id: "readiness", method: "getProviderReadiness" }) as { provider: string; status: string; missingEnv: string[]; reason?: string }

      expect(readiness.provider).toBe("openai")
      expect(readiness.status).toBe("missing_env")
      expect(readiness.missingEnv).toEqual(["OPENAI_API_KEY"])
      expect(readiness.reason).toContain("OPENAI_API_KEY")
    } finally {
      if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenAIKey
      await rm(root, { recursive: true, force: true })
    }
  })

  test("service returns persisted session settings when loading a session", async () => {
    const root = await fixture()
    const context = new ContextManager()
    await new SessionStore(root).save("configured", context, {
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
      thinking: false,
      effort: "medium",
      selectedSkills: ["demo-skill"],
      pendingSkillLoads: ["demo-skill"],
      maxTokens: 12345,
      maxSteps: 23,
    })
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "configured" } }) as { settings: Record<string, unknown> }
    expect(loaded.settings).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
      thinking: false,
      effort: "medium",
      selectedSkills: ["demo-skill"],
      pendingSkillLoads: ["demo-skill"],
      maxTokens: 12345,
      maxSteps: 23,
    })
    await rm(root, { recursive: true, force: true })
  })

  test("desktop restore can reinitialize the active sidecar from loaded session settings", async () => {
    const root = await fixture()
    const context = new ContextManager()
    await new SessionStore(root).save("configured", context, {
      provider: "fake",
      model: "fake-custom-model",
      language: "zh",
      thinking: false,
      effort: "medium",
      selectedSkills: ["demo-skill"],
      pendingSkillLoads: ["demo-skill"],
      maxTokens: 12345,
      maxSteps: 23,
    })
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "configured" } }) as { settings: Record<string, unknown> }
    await service.handle({ id: "restore", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, session: "configured", ...loaded.settings } })
    const restored = await service.handle({ id: "settings", method: "getSettings" }) as { session: string; settings: Record<string, unknown> }

    expect(restored.session).toBe("configured")
    expect(restored.settings).toMatchObject({
      provider: "fake",
      model: "fake-custom-model",
      language: "zh",
      thinking: false,
      effort: "medium",
      selectedSkills: ["demo-skill"],
      pendingSkillLoads: ["demo-skill"],
      maxTokens: 12345,
      maxSteps: 23,
    })
    await rm(root, { recursive: true, force: true })
  })

  test("service persists updateSettings into the current session immediately", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "settings-session" } })

    await service.handle({ id: "settings", method: "updateSettings", params: {
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
      thinking: false,
      effort: "medium",
      maxTokens: 12345,
      maxSteps: 12,
    } })
    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "settings-session" } }) as { settings: Record<string, unknown> }

    expect(loaded.settings).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      language: "zh",
      thinking: false,
      effort: "medium",
      maxTokens: 12345,
      maxSteps: 12,
    })

    await service.handle({ id: "new-session", method: "updateSettings", params: { session: "empty-desktop-session" } })
    const listed = await service.handle({ id: "list", method: "listSessions" }) as { sessions: Array<{ id: string; messageCount: number }> }
    expect(listed.sessions).toContainEqual(expect.objectContaining({ id: "empty-desktop-session", messageCount: 0 }))
    await rm(root, { recursive: true, force: true })
  })

  test("service turns a desktop-created empty session into a titled saved session after the first prompt", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const firstPrompt = "explain cashier flow now"
    const draft = draftSessionPromptPlan(firstPrompt, "chat-draft-session")
    await service.handle({ id: "new-session", method: "updateSettings", params: { session: draft.session } })
    const emptyList = await service.handle({ id: "list-empty", method: "listSessions" }) as { currentSession: string; sessions: Array<{ id: string; messageCount: number; title?: string }> }
    expect(emptyList.currentSession).toBe(draft.session)
    expect(emptyList.sessions).toContainEqual(expect.objectContaining({ id: draft.session, messageCount: 0 }))

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: firstPrompt, session: draft.session } }) as { status: string }
    const listed = await service.handle({ id: "list", method: "listSessions" }) as { currentSession: string; sessions: Array<{ id: string; messageCount: number; title?: string }> }
    const saved = listed.sessions.find((session) => session.id === draft.session)

    expect(result.status).toBe("completed")
    expect(listed.currentSession).toBe(draft.session)
    expect(saved).toMatchObject({ id: draft.session })
    expect(saved?.messageCount).toBeGreaterThan(0)
    expect(saved?.title).toBe(firstPrompt)
    await rm(root, { recursive: true, force: true })
  })

  test("service returns normalized run limits from updateSettings", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const updated = await service.handle({ id: "limits", method: "updateSettings", params: { maxTokens: maxSessionTokens + 1_000, maxSteps: maxSessionSteps + 50 } }) as { settings: { maxTokens?: number; maxSteps?: number } }
    const loaded = await service.handle({ id: "get-limits", method: "getSettings" }) as { settings: { maxTokens?: number; maxSteps?: number } }

    expect(updated.settings.maxTokens).toBe(maxSessionTokens)
    expect(updated.settings.maxSteps).toBe(maxSessionSteps)
    expect(loaded.settings.maxTokens).toBe(maxSessionTokens)
    expect(loaded.settings.maxSteps).toBe(maxSessionSteps)
    await rm(root, { recursive: true, force: true })
  })

  test("service rejects unknown providers in updateSettings", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "settings-session" } })

    await expect(service.handle({ id: "settings", method: "updateSettings", params: { provider: "missing-provider" } })).rejects.toMatchObject({
      code: "invalid_params",
    })
    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "settings-session" } }) as { settings: Record<string, unknown> }
    expect(loaded.settings.provider).toBe("fake")
    await rm(root, { recursive: true, force: true })
  })

  test("service rejects malformed updateSettings values without mutating persisted settings", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "settings-session" } })
    await service.handle({ id: "settings", method: "updateSettings", params: { model: "fake-custom-model", language: "zh", thinking: false, maxTokens: 12345 } })

    await expect(service.handle({ id: "bad-thinking", method: "updateSettings", params: { thinking: "off" } })).rejects.toMatchObject({
      code: "invalid_params",
    })
    await expect(service.handle({ id: "bad-tokens", method: "updateSettings", params: { maxTokens: 0 } })).rejects.toMatchObject({
      code: "invalid_params",
    })

    const loaded = await service.handle({ id: "load", method: "loadSession", params: { session: "settings-session" } }) as { settings: Record<string, unknown> }
    expect(loaded.settings).toMatchObject({
      provider: "fake",
      model: "fake-custom-model",
      language: "zh",
      thinking: false,
      maxTokens: 12345,
    })
    await rm(root, { recursive: true, force: true })
  })

  test("service reads and clears persisted goal status", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const goal = { ...createGoalState("finish desktop goal UI"), status: "planning" as const, acceptanceCriteria: ["goal is visible"], completionChecks: ["clear works"] }
    writeGoalState(context, goal)
    const store = new SessionStore(root)
    await store.save("default", context)
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const status = await service.handle({ id: "goal", method: "getGoalStatus" }) as { goal?: { objective: string; status: string }; text: string }
    expect(status.goal).toMatchObject({ objective: "finish desktop goal UI", status: "planning" })
    expect(status.text).toContain("Goal: finish desktop goal UI")

    const cleared = await service.handle({ id: "clear", method: "clearGoal" }) as unknown as { cleared: boolean }
    expect(cleared.cleared).toBe(true)
    const next = await service.handle({ id: "goal2", method: "getGoalStatus" }) as { goal?: unknown; text: string }
    const persisted = await store.load("default")
    if (!persisted) throw new Error("Expected persisted session after clearing goal.")
    const activeSubjects = currentLedgerSubjects(persisted)

    expect(next.goal).toBeUndefined()
    expect(next.text).toBe("No active goal.")
    for (const subject of goalLedgerSubjects) expect(activeSubjects.has(subject), subject).toBe(false)
    expect(events.some((item) => item.event.type === "goal" && item.event.phase === "cleared")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service pauses and resumes a persisted goal through the shared goal controller", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const goal = {
      ...createGoalState("goal-delegated-e2e"),
      status: "planning" as const,
      complexity: "moderate" as const,
      firstSlice: "Inspect src/add.ts for goal-delegated-e2e",
      acceptanceCriteria: ["goal-delegated-e2e completes after delegated inspection"],
      completionChecks: ["Review goal-delegated-e2e completion state"],
    }
    writeGoalState(context, goal)
    await new SessionStore(root).save("default", context)
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const paused = await service.handle({ id: "pause", method: "pauseGoal", params: { reason: "test pause" } }) as { paused: boolean; goal?: { status: string; blocker?: string }; text: string }
    expect(paused.paused).toBe(true)
    expect(paused.goal).toMatchObject({ status: "paused", blocker: "test pause" })

    const resumed = await service.handle({ id: "resume", method: "resumeGoal" }) as { status: string; text: string }
    expect(resumed.status).toBe("completed")
    expect(resumed.text).toContain("goal-delegated-e2e completed after delegated inspection.")
    const goalStatus = await service.handle({ id: "goal-after-resume", method: "getGoalStatus" }) as { goal?: { status: string; summary?: string }; text: string }
    expect(goalStatus.goal).toMatchObject({ status: "completed" })
    const loaded = await service.handle({ id: "load-after-resume", method: "loadSession", params: { session: "default" } }) as unknown as { messages: unknown[] }
    expect(JSON.stringify(loaded.messages)).toContain("goal-delegated-e2e completed after delegated inspection.")
    expect(events.some((item) => item.event.type === "goal" && item.event.phase === "paused")).toBe(true)
    expect(events.some((item) => item.event.type === "goal" && item.event.phase === "planning")).toBe(true)
    expect(events.some((item) => item.event.type === "run_done")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("desktop fallback auto-rejects unexpected manual permission requests outside Ask mode", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("unexpected manual permission sidecar", (input) => {
      const editDenied = input.messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.toolName === "edit" && part.status === "denied"))
      return editDenied
        ? [{ type: "text_delta" as const, text: "Unexpected manual permission was rejected." }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_unexpected_env", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=unexpected" } } }, { type: "done" as const }]
    })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "unexpected manual permission sidecar", permissionMode: "ask" } })
    const request = await waitFor(() => {
      const event = events.find((item) => item.event.type === "permission_request")
      return event?.event.type === "permission_request" ? event.event.request : undefined
    })
    const presentation = permissionRequestPresentation("goal-restricted", request)
    expect(presentation.showPrompt).toBe(false)
    await service.handle({ id: "reply", method: "replyPermission", params: { requestId: request.id, reply: presentation.autoReply } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("Unexpected manual permission was rejected.")
    expect(await Bun.file(path.join(root, ".env")).text()).toContain("SECRET=x")
    expect(await Bun.file(path.join(root, ".env")).text()).not.toContain("SECRET=unexpected")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 12_000 })

  test("service reads and clears persisted plan status", async () => {
    const root = await fixture()
    const context = new ContextManager()
    const plan = {
      id: "plan_desktop_sidecar",
      title: "Desktop Sidecar Plan",
      lowRisk: true,
      steps: [
        { id: "step_1", goal: "Inspect desktop UI", kind: "inspect" as const },
        { id: "step_2", goal: "Verify sidecar", kind: "verify" as const },
      ],
    }
    await PlanTracker.updateStepStatus(context, root, "default", plan, { step_1: "running", step_2: "pending" }, "step_1", "running")
    const store = new SessionStore(root)
    await store.save("default", context)
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake", session: "default" } })

    const status = await service.handle({ id: "plan", method: "getPlanStatus" }) as { planId?: string; status?: string; currentStepId?: string; text: string }
    expect(status).toMatchObject({ planId: "plan_desktop_sidecar", status: "running", currentStepId: "step_1" })
    expect(status.text).toContain("Plan: Desktop Sidecar Plan")

    const cleared = await service.handle({ id: "clear", method: "clearPlan" }) as unknown as { cleared: boolean }
    expect(cleared.cleared).toBe(true)
    const next = await service.handle({ id: "plan2", method: "getPlanStatus" }) as { planId?: string; text: string }
    const persisted = await store.load("default")
    if (!persisted) throw new Error("Expected persisted session after clearing plan.")
    const activeSubjects = currentLedgerSubjects(persisted)

    expect(next.planId).toBeUndefined()
    expect(next.text).toBe("No active plan.")
    for (const subject of planLedgerSubjects) expect(activeSubjects.has(subject), subject).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("service auto-review mode uses real permission review without manual prompts", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("auto review sensitive sidecar", (input) => {
      const bashResult = input.messages.flatMap((message) => message.parts).find(isBashToolResult)
      return bashResult
        ? [{ type: "text_delta" as const, text: `Auto-review observed ${bashResult.status}.` }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_read_env", name: "bash", input: { command: "cat .env" } } }, { type: "done" as const }]
    })

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: "auto review sensitive sidecar", permissionMode: "auto-review" } })

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("Auto-review observed denied.")
    expect(events.some((item) => item.event.type === "permission_request")).toBe(false)
    expect(events.some((item) => item.event.type === "tool_result" && item.event.status === "denied")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service auto-review mode allows safe verification commands without manual prompts", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse("auto review verification sidecar", (input) => {
      const bashResult = input.messages.flatMap((message) => message.parts).find(isBashToolResult)
      return bashResult
        ? [{ type: "text_delta" as const, text: `Auto-review safe command observed ${bashResult.status}.` }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_bun_test", name: "bash", input: { command: "bun test" } } }, { type: "done" as const }]
    })

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: "auto review verification sidecar", permissionMode: "auto-review" } })

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("Auto-review safe command observed failed.")
    expect(events.some((item) => item.event.type === "permission_request")).toBe(false)
    expect(events.some((item) => item.event.type === "tool_result" && item.event.toolName === "bash" && item.event.status === "denied")).toBe(false)
    expect(events.some((item) => item.event.type === "tool_result" && item.event.toolName === "bash" && item.event.status === "failed")).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service goal mode uses restricted permission policy without manual prompts", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse((input) => input.prompt.toLowerCase().includes("goal-restricted-permission-e2e"), (input) => {
      const editDenied = input.messages.flatMap((message) => message.parts).some((part) => part.type === "tool_result" && part.toolName === "edit" && part.status === "denied")
      return editDenied
        ? [{ type: "tool_call" as const, call: { id: "call_goal_blocked", name: "goal_blocked", input: { reason: "goal restricted permission denied" } } }, { type: "done" as const }]
        : [{ type: "tool_call" as const, call: { id: "call_goal_edit_env", name: "edit", input: { filePath: ".env", oldString: "SECRET=x", newString: "SECRET=z" } } }, { type: "done" as const }]
    })

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: "goal-restricted-permission-e2e", mode: "goal", permissionMode: "auto-review" } })

    expect(result).toMatchObject({ status: "blocked" })
    expect(String((result as { text?: string }).text)).toContain("goal restricted permission denied")
    expect(events.some((item) => item.event.type === "permission_request")).toBe(false)
    expect(events.some((item) => item.event.type === "tool_result" && item.event.toolName === "edit" && item.event.status === "denied")).toBe(true)
    expect(events.some((item) => item.event.type === "run_done" && item.event.status === "blocked")).toBe(true)
    expect(await Bun.file(path.join(root, ".env")).text()).toContain("SECRET=x")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service emits plan approval requests and accepts replies", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "plan-exit", mode: "plan" } })
    const plan = await waitFor(() => events.find((item) => item.event.type === "plan_approval_request"))
    expect(events.some((item) => item.event.type === "run_done")).toBe(false)
    await service.handle({ id: "reply", method: "replyPlan", params: { runId: plan.runId, action: "approve" } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    expect(events.some((item) => item.event.type === "run_done" && item.event.status === "completed")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service reports cancelled run state after rejecting a pending plan", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "plan-exit", mode: "plan" } })
    const plan = await waitFor(() => events.find((item) => item.event.type === "plan_approval_request"))
    expect(events.some((item) => item.event.type === "run_done")).toBe(false)
    await service.handle({ id: "reply", method: "replyPlan", params: { runId: plan.runId, action: "reject" } })
    const result = await pending

    expect(result).toMatchObject({ status: "cancelled" })
    expect(String((result as { text?: string }).text)).toContain("<proposed_plan>")
    expect(events.some((item) => item.event.type === "run_done" && item.event.status === "cancelled")).toBe(true)
    const saved = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text()) as { messages: Array<{ role: string }> }
    expect(saved.messages.some((message) => message.role === "assistant")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service cancelRun resolves a pending plan approval and emits cancelled run_done", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "plan-exit", mode: "plan" } })
    await waitFor(() => events.find((item) => item.event.type === "plan_approval_request"))
    const cancelled = await service.handle({ id: "cancel", method: "cancelRun" }) as { cancelled: boolean; runId?: string }
    const result = await pending

    expect(cancelled.cancelled).toBe(true)
    expect(result).toMatchObject({ status: "cancelled" })
    expect(events.some((item) => item.event.type === "run_done" && item.event.status === "cancelled")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service auto-approves low-risk plans without prompting", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: "low-risk-plan", mode: "plan" } }) as { status: string; text: string }

    expect(result.status).toBe("completed")
    expect(events.some((item) => item.event.type === "plan_approval_request")).toBe(false)
    expect(events.some((item) => item.event.type === "run_done")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service accepts plan edit replies and replans with edited text", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "plan-exit", mode: "plan" } })
    const plan = await waitFor(() => events.find((item) => item.event.type === "plan_approval_request"))
    await service.handle({ id: "reply", method: "replyPlan", params: { runId: plan.runId, action: "edit", text: "Revise the plan: add tests first" } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("revise the plan: add tests first")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service accepts plan new prompt replies and replans with the new prompt", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const pending = service.handle({ id: "run", method: "runPrompt", params: { text: "plan-exit", mode: "plan" } })
    const plan = await waitFor(() => events.find((item) => item.event.type === "plan_approval_request"))
    await service.handle({ id: "reply", method: "replyPlan", params: { runId: plan.runId, action: "new_prompt", text: "new prompt sidecar plan" } })
    const result = await pending

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("new prompt sidecar plan")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 8_000 })

  test("service forwards image inputs to the shared runner", async () => {
    const root = await fixture()
    await Bun.write(path.join(root, "screenshot.png"), "fake png bytes")
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: "describe this screenshot", images: ["screenshot.png"] } })

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("Image received.")
    const saved = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    expect(saved.messages.some((message: any) => message.role === "user" && message.parts.some((part: any) => part.type === "image"))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("service validates image slash add and clear through provider capabilities", async () => {
    const root = await fixture()
    await Bun.write(path.join(root, "screenshot.png"), "fake png bytes")
    await Bun.write(path.join(root, "screen shot.png"), "fake png bytes")
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const added = await service.handle({ id: "image-add", method: "executeSlashCommand", params: { text: "/image screenshot.png" } }) as { handled: boolean; title: string; text: string; action?: { type: string; path?: string; label?: string } }
    expect(added).toMatchObject({ handled: true, title: "Image", action: { type: "addImage", path: "screenshot.png" } })
    expect(added.text).toContain("Attached image:")

    const spaced = await service.handle({ id: "image-add-spaced", method: "executeSlashCommand", params: { text: "/image screen shot.png" } }) as { handled: boolean; action?: { type: string; path?: string; label?: string } }
    expect(spaced).toMatchObject({ handled: true, action: { type: "addImage", path: "screen shot.png", label: "screen shot.png" } })

    const cleared = await service.handle({ id: "image-clear", method: "executeSlashCommand", params: { text: "/image clear" } }) as { handled: boolean; action?: { type: string }; text: string }
    expect(cleared).toMatchObject({ handled: true, action: { type: "clearImages" } })
    expect(cleared.text).toContain("Pending images cleared.")
    await rm(root, { recursive: true, force: true })
  })

  test("service validates file slash add and clear through workspace boundaries", async () => {
    const root = await fixture()
    await Bun.write(path.join(root, "src", "with space.ts"), "export const spaced = true\n")
    const outside = path.join(os.tmpdir(), `easycode-outside-${Date.now()}.txt`)
    await Bun.write(outside, "outside")
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const added = await service.handle({ id: "file-add", method: "executeSlashCommand", params: { text: "/file src/add.ts" } }) as { handled: boolean; title: string; text: string; action?: { type: string; path?: string; label?: string } }
    expect(added).toMatchObject({ handled: true, title: "File", action: { type: "addFile", label: "src/add.ts" } })
    expect(added.action?.path).toBe(path.join(root, "src", "add.ts"))
    expect(added.text).toContain("Attached file:")

    const spaced = await service.handle({ id: "file-add-spaced", method: "executeSlashCommand", params: { text: "/file src/with space.ts" } }) as { handled: boolean; action?: { type: string; path?: string; label?: string } }
    expect(spaced).toMatchObject({ handled: true, action: { type: "addFile", label: "src/with space.ts" } })
    expect(spaced.action?.path).toBe(path.join(root, "src", "with space.ts"))

    const blocked = await service.handle({ id: "file-outside", method: "executeSlashCommand", params: { text: `/file ${outside}` } }) as { handled: boolean; text: string; action?: unknown }
    expect(blocked.handled).toBe(true)
    expect(blocked.text).toContain("Attached file must be inside the workspace")
    expect(blocked.action).toBeUndefined()

    const cleared = await service.handle({ id: "file-clear", method: "executeSlashCommand", params: { text: "/file clear" } }) as { handled: boolean; action?: { type: string }; text: string }
    expect(cleared).toMatchObject({ handled: true, action: { type: "clearFiles" } })
    expect(cleared.text).toContain("Pending files cleared.")
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  })

  test("service reports unsupported image providers before the GUI attaches images", async () => {
    const root = await fixture()
    await Bun.write(path.join(root, "screenshot.png"), "fake png bytes")
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "deepseek" } })

    const result = await service.handle({ id: "image-add", method: "executeSlashCommand", params: { text: "/image screenshot.png" } }) as { handled: boolean; text: string; action?: unknown }

    expect(result.handled).toBe(true)
    expect(result.text).toContain("does not support image input")
    expect(result.action).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  test("desktop picker slash actions become real image and file run attachments", async () => {
    const root = await fixture()
    const outside = path.join(os.tmpdir(), `easycode-outside-${Date.now()}.txt`)
    await Bun.write(path.join(root, "screenshot.png"), "fake png bytes")
    await Bun.write(outside, "outside")
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    const pickerPlan = pickedFileSlashCommands([
      { path: path.join(root, "src", "add.ts"), name: "add.ts", size: 42, insideWorkspace: true, relativePath: "src/add.ts" },
      { path: path.join(root, "screenshot.png"), name: "screenshot.png", size: 12, insideWorkspace: true, relativePath: "screenshot.png" },
      { path: outside, name: "outside.txt", size: 7, insideWorkspace: false },
    ])
    let attachments: DesktopAttachment[] = []

    expect(pickerPlan.rejectedCount).toBe(1)
    expect(pickerPlan.commands).toEqual([
      `/file ${path.join(root, "src", "add.ts")}`,
      `/image ${path.join(root, "screenshot.png")}`,
    ])
    for (const [index, command] of pickerPlan.commands.entries()) {
      const result = await service.handle({ id: `attach-${index}`, method: "executeSlashCommand", params: { text: command } }) as { handled: boolean; action?: Parameters<typeof applyAttachmentAction>[1] }
      expect(result.handled).toBe(true)
      attachments = applyAttachmentAction(attachments, result.action, `attachment_${index}`)
    }

    expect(attachments.map((attachment) => attachment.kind).sort()).toEqual(["file", "image"])
    const run = await service.handle({
      id: "run",
      method: "runPrompt",
      params: {
        text: "inspect picker attachments",
        images: attachments.filter((attachment) => attachment.kind === "image").map((attachment) => attachment.path),
        files: attachments.filter((attachment) => attachment.kind === "file").map((attachment) => attachment.path),
      },
    }) as { status: string; text?: string }

    expect(run.status).toBe("completed")
    expect(run.text).toContain("Image received.")
    const saved = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    const userMessage = saved.messages.find((message: any) => message.role === "user")
    const userText = userMessage?.parts.find((part: any) => part.type === "text")?.text
    expect(userText).toContain("<attached_files>")
    expect(userText).toContain("- src/add.ts")
    expect(userText).not.toContain(root)
    expect(userMessage?.parts.some((part: any) => part.type === "image")).toBe(true)
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  })

  test("service forwards file attachments as structured workspace references", async () => {
    const root = await fixture()
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })
    FakeProvider.registerResponse((input) => input.prompt.includes("<attached_files>") && input.prompt.includes("- src/add.ts"), [
      { type: "text_delta" as const, text: "Attached file reference received." },
      { type: "done" as const },
    ])

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: "inspect the selected file", files: [path.join(root, "src", "add.ts")] } })

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("Attached file reference received.")
    const saved = JSON.parse(await Bun.file(path.join(root, ".easycode", "sessions", "default.json")).text())
    const userText = saved.messages.find((message: any) => message.role === "user")?.parts.find((part: any) => part.type === "text")?.text
    expect(userText).toContain("<attached_files>")
    expect(userText).toContain("- src/add.ts")
    expect(userText).not.toContain(root)
    await rm(root, { recursive: true, force: true })
  })

  test("service rejects attached files outside the workspace", async () => {
    const root = await fixture()
    const outside = path.join(os.tmpdir(), `easycode-outside-${Date.now()}.txt`)
    await Bun.write(outside, "outside")
    const service = new SidecarService(() => {})
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    await expect(service.handle({ id: "run", method: "runPrompt", params: { text: "inspect outside", files: [outside] } })).rejects.toThrow("Attached file must be inside the workspace")

    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  })

  test("service runs goal mode through shared goal controller", async () => {
    const root = await fixture()
    const events: SidecarEventEnvelope[] = []
    const service = new SidecarService((event) => events.push(event))
    await service.handle({ id: "init", method: "initialize", params: { protocolVersion: sidecarProtocolVersion, root, provider: "fake" } })

    const result = await service.handle({ id: "run", method: "runPrompt", params: { text: "goal-delegated-e2e", mode: "goal" } })

    expect(result).toMatchObject({ status: "completed" })
    expect(String((result as { text?: string }).text)).toContain("goal-delegated-e2e completed after delegated inspection.")
    expect(events.some((item) => item.event.type === "goal" && item.event.phase === "started")).toBe(true)
    expect(events.some((item) => item.event.type === "goal" && item.event.phase === "planning")).toBe(true)
    expect(events.some((item) => item.event.type === "goal" && item.event.phase === "executing")).toBe(true)
    expect(events.some((item) => item.event.type === "goal" && item.event.phase === "completed")).toBe(true)
    expect(events.filter((item) => item.event.type === "run_done")).toHaveLength(1)
    const loaded = await service.handle({ id: "load-goal-session", method: "loadSession", params: { session: "default" } }) as unknown as { messages: unknown[] }
    expect(JSON.stringify(loaded.messages)).toContain("goal-delegated-e2e completed after delegated inspection.")
    await rm(root, { recursive: true, force: true })
  }, { timeout: 12_000 })
})

async function readJsonLines(stream: ReadableStream<Uint8Array> | null, frames: any[]) {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) frames.push(JSON.parse(line))
    }
  }
}

function isBashToolResult(part: MessagePart): part is ToolResultPart {
  return part.type === "tool_result" && part.toolName === "bash"
}

function currentLedgerSubjects(session: { ledger?: { current?: Array<{ subject?: string }> } }) {
  return new Set((session.ledger?.current ?? []).map((record) => record.subject).filter((subject): subject is string => Boolean(subject)))
}
