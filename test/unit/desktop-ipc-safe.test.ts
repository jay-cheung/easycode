import { describe, expect, test } from "bun:test"
import { normalizeIpcError, withIpcErrorBoundary } from "../../apps/desktop/src/main/ipc-safe"

describe("desktop IPC safety", () => {
  test("passes successful handler results through", async () => {
    const handler = withIpcErrorBoundary(async (_event: unknown, value: number) => value + 1)
    await expect(handler({}, 41)).resolves.toBe(42)
  })

  test("preserves Error instances from handlers", async () => {
    const original = new Error("sidecar stopped")
    const handler = withIpcErrorBoundary(() => {
      throw original
    })
    await expect(handler()).rejects.toBe(original)
  })

  test("normalizes non-Error failures into useful Error instances", async () => {
    const stringHandler = withIpcErrorBoundary(() => {
      throw "sidecar missing"
    })
    const emptyHandler = withIpcErrorBoundary(() => {
      throw undefined
    })

    await expect(stringHandler()).rejects.toThrow("sidecar missing")
    await expect(emptyHandler()).rejects.toThrow("Desktop IPC request failed.")
    expect(normalizeIpcError({ message: "opaque" }).message).toBe("Desktop IPC request failed.")
  })
})
