import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createLogger, formatLogEvent, type LogEvent } from "../../src/logger"

function event(type: LogEvent["type"]): LogEvent {
  return { at: 1, type, name: `${type}.event` }
}

describe("logger", () => {
  test("writes events to the session log file without terminal output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easycode-logger-"))
    const infoLines: string[] = []
    const errorLines: string[] = []
    const originalInfo = console.info
    const originalError = console.error
    console.info = (line?: unknown) => infoLines.push(String(line))
    console.error = (line?: unknown) => errorLines.push(String(line))
    try {
      const logger = createLogger({ root, session: "demo/session" })
      logger(event("data"))
      logger(event("state"))
      logger(event("error"))
      logger({
        at: 2,
        type: "provider",
        name: "provider.transcript",
        detail: {
          input: [
            '<message index="0" role="system">',
            "cached",
            "</message>",
            "",
            '<message index="1" role="user">',
            "miss",
            "</message>",
            "",
            '<message index="2" role="tool">',
            '<tool_result name="read" id="call_1" status="succeeded">',
            "ok",
            "</tool_result>",
            "</message>",
          ].join("\n"),
          cachedInput: "cached",
          uncachedInput: "miss",
          reasoningContent: "inspect first",
          output: "answer",
          usage: { inputTokens: 10, cacheHitTokens: 4, cacheMissTokens: 6, outputTokens: 2 },
        },
      })
      logger({
        at: 2,
        type: "provider",
        name: "provider.validation_rejected",
        detail: {
          attempt: 1,
          maxAttempts: 3,
          shouldRetry: true,
          failureText: "Planning mode hard gate failed.",
          correction: "Return a proposed plan.",
        },
      })
      logger({
        at: 3,
        type: "provider",
        name: "provider.transcript",
        detail: {
          input: [
            '<message index="0" role="system">',
            "cached",
            "</message>",
            "",
            '<message index="1" role="user">',
            "miss2",
            "</message>",
          ].join("\n"),
          cachedInput: "cached",
          uncachedInput: "miss2",
          output: "answer2",
          usage: { inputTokens: 11, cacheHitTokens: 4, cacheMissTokens: 7, outputTokens: 3 },
        },
      })
      expect(logger.filePath).toBe(path.join(root, ".easycode", "logs", "sessions", "demo_session.jsonl"))
      expect(logger.transcriptFilePath).toBe(path.join(root, ".easycode", "logs", "sessions", "demo_session.txt"))
    } finally {
      console.info = originalInfo
      console.error = originalError
    }
    expect(infoLines).toHaveLength(0)
    expect(errorLines).toHaveLength(0)
    const lines = (await Bun.file(path.join(root, ".easycode", "logs", "sessions", "demo_session.jsonl")).text()).trim().split("\n")
    expect(lines).toHaveLength(6)
    expect(JSON.parse(lines[2])).toMatchObject({ type: "error", name: "error.event" })
    const transcript = await Bun.file(path.join(root, ".easycode", "logs", "sessions", "demo_session.txt")).text()
    expect(transcript).toContain("Turn 1\n\nInput\n\nSystem\n\ncached\n\nUser\n\nmiss\n\nTool\n\n<tool_result name=\"read\" id=\"call_1\" status=\"succeeded\">\nok\n</tool_result>\n\nReasoning\n\ninspect first\n\nOutput\n\nAssistant\n\nanswer\n\nCache\n\n40.0%, cache hit: yes, input=10, cached=4, miss=6, output=2\nprovider reported cached tokens: 4\nexact cached text span: unavailable from provider")
    expect(transcript).toContain("Validation\n\nrejected, retrying (1/3)\nPlanning mode hard gate failed.\n\nCorrection\n\nReturn a proposed plan.")
    expect(transcript).toContain("Turn 2")
    expect(transcript).toContain("common prefix with previous turn: chars=89, estimated_tokens=27")
    await rm(root, { recursive: true, force: true })
  })

  test("highlights state events", () => {
    expect(formatLogEvent(event("state"))).toContain("\x1b[1;36m")
    expect(formatLogEvent(event("data"))).not.toContain("\x1b[1;36m")
  })

  test("highlights network request and response events", () => {
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.response" })).toContain("\x1b[1;33m")
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.response.raw" })).toContain("\x1b[1;33m")
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.done" })).not.toContain("\x1b[1;33m")
  })

  test("highlights provider input token events in green", () => {
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.input_tokens", detail: { tokenEstimate: 12 } })).toContain("\x1b[1;32m")
  })

  test("highlights provider summary events", () => {
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.summary_request" })).toContain("\x1b[1;35m")
    expect(formatLogEvent({ at: 1, type: "provider", name: "provider.summary_output" })).toContain("\x1b[1;35m")
  })
})
