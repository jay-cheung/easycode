import { describe, expect, test } from "bun:test"
import path from "node:path"
import { workspacePathInfo } from "../../apps/desktop/src/main/workspace-path"

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
})
