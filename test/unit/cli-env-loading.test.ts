import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadEnvFile } from "../../src/cli/startup"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-cli-env-"))
}

describe("cli env loading edge cases", () => {
  test("loads dotenv values over blank inherited values", async () => {
    const root = await tmpdir()
    const providerKey = ["OPENAI", "API", "KEY"].join("_")
    try {
      await Bun.write(path.join(root, ".env"), `${providerKey}=from-file\nEXISTING=from-file\n`)
      const env: Record<string, string | undefined> = { [providerKey]: "", EXISTING: "from-process" }

      expect(await loadEnvFile(root, env)).toBe(1)
      expect(env[providerKey]).toBe("from-file")
      expect(env.EXISTING).toBe("from-process")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
