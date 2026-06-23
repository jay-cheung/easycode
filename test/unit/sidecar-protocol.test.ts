import { describe, expect, test } from "bun:test"
import { encodeSidecarEvent, encodeSidecarResponse, parseSidecarRequestLine, SidecarProtocolError } from "../../src/sidecar"
import { parseExecuteSlashCommandParams, parseUpdateSettingsParams } from "../../src/sidecar/params"

describe("sidecar protocol", () => {
  test("parses supported JSONL requests", () => {
    expect(parseSidecarRequestLine('{"id":"1","method":"initialize","params":{"protocolVersion":1}}')).toEqual({
      id: "1",
      method: "initialize",
      params: { protocolVersion: 1 },
    })
    expect(parseSidecarRequestLine('{"id":"skills","method":"listSkills"}')).toEqual({
      id: "skills",
      method: "listSkills",
      params: undefined,
    })
    expect(parseSidecarRequestLine('{"id":"readiness","method":"getProviderReadiness"}')).toEqual({
      id: "readiness",
      method: "getProviderReadiness",
      params: undefined,
    })
    expect(parseSidecarRequestLine('{"id":"goal","method":"getGoalStatus"}')).toEqual({
      id: "goal",
      method: "getGoalStatus",
      params: undefined,
    })
    expect(parseSidecarRequestLine('{"id":"pause","method":"pauseGoal"}')).toEqual({
      id: "pause",
      method: "pauseGoal",
      params: undefined,
    })
    expect(parseSidecarRequestLine('{"id":"resume","method":"resumeGoal"}')).toEqual({
      id: "resume",
      method: "resumeGoal",
      params: undefined,
    })
    expect(parseSidecarRequestLine('{"id":"plan","method":"getPlanStatus"}')).toEqual({
      id: "plan",
      method: "getPlanStatus",
      params: undefined,
    })
    expect(parseSidecarRequestLine('{"id":"slash","method":"executeSlashCommand","params":{"text":"/settings"}}')).toEqual({
      id: "slash",
      method: "executeSlashCommand",
      params: { text: "/settings" },
    })
  })

  test("rejects malformed requests", () => {
    expect(() => parseSidecarRequestLine("{")).toThrow(SidecarProtocolError)
    expect(() => parseSidecarRequestLine('{"id":"","method":"initialize"}')).toThrow("Request id")
    expect(() => parseSidecarRequestLine('{"id":"1","method":"missing"}')).toThrow("not supported")
  })

  test("validates slash attachment counters", () => {
    expect(parseExecuteSlashCommandParams({ text: "/settings", pendingImages: 1, pendingFiles: 2 })).toEqual({
      text: "/settings",
      pendingImages: 1,
      pendingFiles: 2,
    })
    expect(() => parseExecuteSlashCommandParams({ text: "/settings", pendingFiles: -1 })).toThrow("pendingFiles")
    expect(() => parseExecuteSlashCommandParams({ text: "/settings", pendingFiles: 1.5 })).toThrow("pendingFiles")
  })

  test("validates updateSettings params before session persistence", () => {
    expect(parseUpdateSettingsParams({
      session: " demo ",
      provider: "openai",
      model: null,
      language: "zh",
      thinking: false,
      effort: "max",
      maxTokens: 64000,
      maxSteps: null,
      selectedSkills: ["demo"],
      pendingSkillLoads: ["demo"],
      ignored: "field",
    })).toEqual({
      session: "demo",
      provider: "openai",
      model: undefined,
      language: "zh",
      thinking: false,
      effort: "max",
      maxTokens: 64000,
      maxSteps: undefined,
      selectedSkills: ["demo"],
      pendingSkillLoads: ["demo"],
    })
    expect(() => parseUpdateSettingsParams({ provider: "" })).toThrow("provider")
    expect(() => parseUpdateSettingsParams({ thinking: "off" })).toThrow("thinking")
    expect(() => parseUpdateSettingsParams({ maxTokens: 0 })).toThrow("maxTokens")
    expect(() => parseUpdateSettingsParams({ selectedSkills: ["demo", 1] })).toThrow("selectedSkills")
  })

  test("serializes responses and events as JSONL", () => {
    expect(encodeSidecarResponse({ id: "1", ok: true, result: { ready: true } })).toBe('{"id":"1","ok":true,"result":{"ready":true}}\n')
    expect(encodeSidecarEvent({ type: "event", event: { type: "session_changed", session: "default" } })).toBe('{"type":"event","event":{"type":"session_changed","session":"default"}}\n')
  })
})
