import { describe, expect, test } from "bun:test"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")

async function rendererFile(relativePath: string) {
  return Bun.file(path.join(repoRoot, "apps/desktop/src/renderer", relativePath)).text()
}

describe("desktop renderer UI contracts", () => {
  test("keeps session creation at the workspace row level only", async () => {
    const source = await rendererFile("App.tsx")

    expect(source).toContain('aria-label={`New session in ${workspaceDisplayName(root)}`}')
    expect(source).not.toContain("session-subtitle")
    expect(source).not.toContain("<span>Sessions</span>")
    expect(source).not.toContain('aria-label="New session"')
  })

  test("opens workspace menus through hover and focus instead of click state", async () => {
    const source = await rendererFile("App.tsx")
    const css = await rendererFile("styles.css")

    expect(source).toContain('className="workspace-menu-host"')
    expect(source).not.toContain("workspaceMenuOpen")
    expect(source).not.toContain("setWorkspaceMenuOpen")
    expect(css).toContain(".workspace-menu {\n  position: absolute")
    expect(css).toContain("display: none")
    expect(css).toContain(".workspace-menu-host:hover .workspace-menu")
    expect(css).toContain(".workspace-menu-host:focus-within .workspace-menu")
  })

  test("does not auto-scroll the stream when a tool row is expanded", async () => {
    const source = await rendererFile("App.tsx")

    expect(source).toContain("const skipNextStreamScrollRef = useRef(false)")
    expect(source).toContain("if (skipNextStreamScrollRef.current)")
    expect(source).toContain("const toggleToolRow = (id: string)")
    expect(source).toContain("skipNextStreamScrollRef.current = true")
    expect(source).toContain("onToggle={toggleToolRow}")
  })

  test("uses compact typography for sidebar sessions and message markdown", async () => {
    const css = await rendererFile("styles.css")

    expect(css).toContain(".thread-row")
    expect(css).toContain("min-height: 32px")
    expect(css).toContain("font-size: 13px")
    expect(css).toContain(".markdown-body h1 {\n  font-size: 18px;\n}")
    expect(css).toContain(".markdown-body h2 {\n  font-size: 16px;\n}")
    expect(css).toContain(".markdown-body h3 {\n  font-size: 15px;\n}")
  })
})
