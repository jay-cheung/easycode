import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolveWorkspaceFilePath, workspacePathInfo } from "../../apps/desktop/src/main/workspace-path"

describe("desktop workspace path helpers", () => {
  test("marks files inside the workspace and returns a relative path", () => {
    const root = path.resolve("/tmp/easycode-workspace")
    const file = path.join(root, "src", "index.ts")

    expect(workspacePathInfo(root, file)).toEqual({
      insideWorkspace: true,
      relativePath: path.join("src", "index.ts"),
    })
  })

  test("rejects files outside the workspace", () => {
    const root = path.resolve("/tmp/easycode-workspace")
    const file = path.resolve("/tmp/other-workspace/src/index.ts")

    expect(workspacePathInfo(root, file)).toEqual({ insideWorkspace: false })
  })

  test("does not treat the workspace directory itself as an attachable file", () => {
    const root = path.resolve("/tmp/easycode-workspace")

    expect(workspacePathInfo(root, root)).toEqual({ insideWorkspace: false })
  })

  test("resolves repo-root markdown links when the active workspace is a subdirectory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "easycode-root-"))
    await mkdir(path.join(root, ".git"))
    await mkdir(path.join(root, "apps", "desktop"), { recursive: true })
    await mkdir(path.join(root, "scripts"), { recursive: true })
    await writeFile(path.join(root, "scripts", "desktop-verify.mjs"), "")

    await expect(resolveWorkspaceFilePath(path.join(root, "apps", "desktop"), "scripts/desktop-verify.mjs")).resolves.toBe(path.join(root, "scripts", "desktop-verify.mjs"))
  })

  test("resolves bare file names by searching the nearest repo root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "easycode-root-"))
    await mkdir(path.join(root, ".git"))
    await mkdir(path.join(root, "apps", "desktop", "src", "renderer"), { recursive: true })
    await writeFile(path.join(root, "apps", "desktop", "src", "renderer", "App.tsx"), "")

    await expect(resolveWorkspaceFilePath(path.join(root, "apps", "desktop"), "App.tsx")).resolves.toBe(path.join(root, "apps", "desktop", "src", "renderer", "App.tsx"))
  })
})
