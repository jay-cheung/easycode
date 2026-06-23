import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("desktop renderer security", () => {
  test("declares a CSP for the Electron renderer", async () => {
    const html = await Bun.file(path.join(import.meta.dir, "../../apps/desktop/index.html")).text()

    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("default-src 'self'")
    expect(html).toContain("script-src 'self'")
    expect(html).toContain("object-src 'none'")
  })
})
