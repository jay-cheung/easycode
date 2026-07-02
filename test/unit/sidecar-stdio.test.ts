import { describe, expect, test } from "bun:test"
import { configureSidecarStdioArgs, shouldHandleImmediately } from "../../src/sidecar/stdio"

describe("sidecar stdio args", () => {
  test("maps -k to insecure TLS for sidecar mode", () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    try {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      configureSidecarStdioArgs(["--stdio", "-k"])
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED as string | undefined).toBe("0")
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous
    }
  })

  test("requires stdio mode", () => {
    expect(() => configureSidecarStdioArgs(["-k"])).toThrow("Usage: easycode sidecar --stdio [--insecure|-k]")
  })

  test("lets run control replies bypass the long-running request queue", () => {
    expect(shouldHandleImmediately({ method: "replyPermission" })).toBe(true)
    expect(shouldHandleImmediately({ method: "replyPlan" })).toBe(true)
    expect(shouldHandleImmediately({ method: "cancelRun" })).toBe(true)
    expect(shouldHandleImmediately({ method: "runPrompt" })).toBe(false)
    expect(shouldHandleImmediately({ method: "initialize" })).toBe(false)
  })
})
