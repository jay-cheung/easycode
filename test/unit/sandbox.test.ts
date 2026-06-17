import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { looksLikeNativeSandboxDenial, macosSandboxProfile, Sandbox, SandboxBoundaryError, SandboxCommandError, SandboxPathEscapeError } from "../../src/sandbox"

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), "easycode-sandbox-"))
}

describe("sandbox", () => {
  test("native write sandbox permits dev null and current macOS temp roots while blocking broad external writes", () => {
    const profile = macosSandboxProfile("/tmp/easycode-root")
    expect(profile).toContain('(require-not (subpath "/tmp/easycode-root"))')
    expect(profile).toContain('(require-not (subpath "/private/tmp/easycode-root"))')
    expect(profile).toContain('(require-not (subpath "/tmp"))')
    expect(profile).toContain('(require-not (subpath "/private/tmp"))')
    const sessionTempRoot = path.dirname(os.tmpdir())
    if (/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+$/.test(sessionTempRoot)) {
      expect(profile).toContain(`(require-not (subpath "${sessionTempRoot}"))`)
    }
    expect(profile).not.toContain('(require-not (subpath "/private/var/folders"))')
    expect(profile).toContain('(require-not (literal "/dev/null"))')
    expect(profile).toContain('(require-not (literal "/private/dev/null"))')
  })

  test("detects native sandbox denial from command output", () => {
    expect(
      looksLikeNativeSandboxDenial({
        exitCode: 1,
        stdout: "",
        stderr: "fatal: could not open '/dev/null' for reading and writing: Operation not permitted",
        nativeWriteSandbox: true,
        sandboxBypassed: false,
      }),
    ).toBe(true)
    expect(
      looksLikeNativeSandboxDenial({
        exitCode: 1,
        stdout: "",
        stderr: "regular command failure",
        nativeWriteSandbox: true,
        sandboxBypassed: false,
      }),
    ).toBe(false)
  })

  test("blocks writes outside root", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root)
    expect(() => sandbox.resolve("../outside.txt")).toThrow(SandboxBoundaryError)
    await rm(root, { recursive: true, force: true })
  })

  test("denies dangerous commands", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root)
    await expect(sandbox.execute({ command: "rm -rf tmp" })).rejects.toThrow(SandboxCommandError)
    await rm(root, { recursive: true, force: true })
  })

  test("allows download pipe shell commands to reach permission review instead of sandbox hard deny", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root)
    await expect(sandbox.execute({ command: "printf '#!/bin/sh\\necho ok\\n' | sh" })).resolves.toMatchObject({ exitCode: 0 })
    await rm(root, { recursive: true, force: true })
  })

  test("denies network commands when network policy is disabled", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root, { network: "deny" })
    await expect(sandbox.execute({ command: "curl https://example.test" })).rejects.toThrow("Network command denied")
    await expect(sandbox.execute({ command: "npm install" })).rejects.toThrow("Network command denied")
    await rm(root, { recursive: true, force: true })
  })

  test("redacts sensitive env values from bash output", async () => {
    const root = await tmpdir()
    process.env.EASYCODE_TEST_SECRET = "super-secret-value"
    const sandbox = new Sandbox(root)
    const result = await sandbox.execute({ command: "printf super-secret-value" })
    expect(result.stdout).toBe("[redacted]")
    delete process.env.EASYCODE_TEST_SECRET
    await rm(root, { recursive: true, force: true })
  })

  test("legacy readonly sandbox mode still blocks side-effectful bash", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root)
    await expect(sandbox.execute({ command: "touch x" }, "plan")).rejects.toThrow(SandboxCommandError)
    await rm(root, { recursive: true, force: true })
  })

  test("blocks bash path escapes outside root", async () => {
    const root = await tmpdir()
    const outside = "/var/easycode-outside.txt"
    const sandbox = new Sandbox(root)
    await expect(sandbox.execute({ command: `printf x > ${outside}` })).rejects.toThrow(SandboxPathEscapeError)
    await expect(sandbox.execute({ command: "cat ~/easycode-outside.txt" })).rejects.toThrow(SandboxPathEscapeError)
    await expect(sandbox.execute({ command: "printf x --output=/var/easycode-outside.txt" })).rejects.toThrow(SandboxPathEscapeError)
    expect(await Bun.file(outside).exists()).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("allows tmp and dev null command paths without path-boundary bypass", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root)
    const tmp = await sandbox.execute({ command: "printf ok > /tmp/easycode-sandbox-allowed.txt && cat /tmp/easycode-sandbox-allowed.txt" })
    const devNull = await sandbox.execute({ command: "printf ok > /dev/null" })
    expect(tmp.exitCode).toBe(0)
    expect(tmp.pathBoundaryBypassed).toBe(false)
    expect(devNull.exitCode).toBe(0)
    expect(devNull.pathBoundaryBypassed).toBe(false)
    await rm("/tmp/easycode-sandbox-allowed.txt", { force: true })
    await rm(root, { recursive: true, force: true })
  })

  test("times out commands", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root)
    const result = await sandbox.execute({ command: "sleep 5", timeoutMs: 20 })
    expect(result.timedOut).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("cancels running commands with an abort signal", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const result = await sandbox.execute({ command: "sleep 5" }, "build", { signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(result.timedOut).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("truncates large output", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root, { maxOutputBytes: 10 })
    const result = await sandbox.execute({ command: "printf 123456789012345" })
    expect(result.truncated).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("extracts diagnostic lines before truncating command output", async () => {
    const root = await tmpdir()
    const sandbox = new Sandbox(root, { maxOutputBytes: 13 })
    const result = await sandbox.execute({ command: "printf 'begin\\nASSERT FAILED in the middle\\nend-of-output'" })
    expect(result.truncated).toBe(true)
    expect(result.stdout).toBe("end-of-output")
    expect(result.stdoutDiagnostics).toContain("ASSERT FAILED in the middle")
    await rm(root, { recursive: true, force: true })
  })
})
