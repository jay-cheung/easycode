import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("desktop package scripts", () => {
  test("declares the desktop app name for Electron dev and packaged builds", async () => {
    const manifest = await Bun.file(path.join(import.meta.dir, "../../apps/desktop/package.json")).json() as {
      productName?: string
      build?: { productName?: string, mac?: { extendInfo?: Record<string, string> } }
    }

    expect(manifest.productName).toBe("easycode")
    expect(manifest.build?.productName).toBe("easycode")
    expect(manifest.build?.mac?.extendInfo?.CFBundleDisplayName).toBe("easycode")
    expect(manifest.build?.mac?.extendInfo?.CFBundleName).toBe("easycode")
  })

  test("electron script builds preload dependencies before launching Electron", async () => {
    const manifest = await Bun.file(path.join(import.meta.dir, "../../apps/desktop/package.json")).json() as {
      scripts?: Record<string, string>
    }

    expect(manifest.scripts?.electron).toBe("bun run build && node scripts/run-electron.mjs")
    expect(manifest.scripts?.dev).toContain("node scripts/run-electron.mjs")
    expect(manifest.scripts?.build).toContain("node scripts/bundle-preload.mjs")
  })
})
