import { describe, expect, test } from "bun:test"
import { createLogger, formatLogEvent, type LogEvent } from "../../src/logger"

function event(type: LogEvent["type"]): LogEvent {
  return { at: 1, type, name: `${type}.event` }
}

describe("logger", () => {
  test("writes only error events to stderr", () => {
    const infoLines: string[] = []
    const errorLines: string[] = []
    const originalInfo = console.info
    const originalError = console.error
    console.info = (line?: unknown) => infoLines.push(String(line))
    console.error = (line?: unknown) => errorLines.push(String(line))
    try {
      const logger = createLogger()
      logger(event("data"))
      logger(event("state"))
      logger(event("error"))
    } finally {
      console.info = originalInfo
      console.error = originalError
    }
    expect(infoLines).toHaveLength(2)
    expect(errorLines).toHaveLength(1)
    expect(errorLines[0]).toContain("\"type\":\"error\"")
  })

  test("highlights state events", () => {
    expect(formatLogEvent(event("state"))).toContain("\x1b[1;36m")
    expect(formatLogEvent(event("data"))).not.toContain("\x1b[1;36m")
  })

  test("highlights network request and response events", () => {
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.request" })).toContain("\x1b[1;33m")
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.response" })).toContain("\x1b[1;33m")
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.response.raw" })).toContain("\x1b[1;33m")
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.done" })).not.toContain("\x1b[1;33m")
  })
})
