import { describe, expect, test } from "bun:test"
import { encodeSidecarEvent, encodeSidecarResponse, parseSidecarRequestLine, SidecarProtocolError } from "../../src/sidecar"

describe("sidecar protocol", () => {
  test("parses supported JSONL requests", () => {
    expect(parseSidecarRequestLine('{"id":"1","method":"initialize","params":{"protocolVersion":1}}')).toEqual({
      id: "1",
      method: "initialize",
      params: { protocolVersion: 1 },
    })
  })

  test("rejects malformed requests", () => {
    expect(() => parseSidecarRequestLine("{")).toThrow(SidecarProtocolError)
    expect(() => parseSidecarRequestLine('{"id":"","method":"initialize"}')).toThrow("Request id")
    expect(() => parseSidecarRequestLine('{"id":"1","method":"missing"}')).toThrow("not supported")
  })

  test("serializes responses and events as JSONL", () => {
    expect(encodeSidecarResponse({ id: "1", ok: true, result: { ready: true } })).toBe('{"id":"1","ok":true,"result":{"ready":true}}\n')
    expect(encodeSidecarEvent({ type: "event", event: { type: "session_changed", session: "default" } })).toBe('{"type":"event","event":{"type":"session_changed","session":"default"}}\n')
  })
})
