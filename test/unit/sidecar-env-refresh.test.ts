import { describe, expect, test } from "bun:test"

describe("sidecar environment refresh", () => {
  test("refreshes dotenv-backed process env before readiness and runs", async () => {
    const source = await Bun.file(new URL("../../src/sidecar/service.ts", import.meta.url)).text()

    expect(source).toContain("private async reloadEnvironment()")
    expect(source).toContain("this.loadedEnvVars = await loadEnvFile(this.root)")
    expect(source).toContain("private async providerReadiness() {\n    await this.reloadEnvironment()")
    expect(source).toContain("await this.reloadEnvironment()\n    emitLog(logger, { type: \"data\", name: \"sidecar.run\"")
    expect(source).toContain("private async runOnce")
    expect(source).toContain("private async runOnce(runId: string")
    expect(source).toContain("= {}) {\n    await this.reloadEnvironment()")
  })
})
