import { describe, expect, test } from "bun:test"
import { applyAttachmentAction, clearAttachmentSlashCommands, fileAttachment, fileSlashCommand, formatAttachmentBytes, imageAttachment, imageSlashCommand, isImageFile, pickedFileSlashCommands, planPickedFiles, rejectedWorkspaceFileSummary, removeFileRefs, slashFileName, slashImageName, workspaceFileAttachment } from "../../apps/desktop/src/renderer/attachment-state"

describe("desktop attachment state", () => {
  test("classifies picked files like the desktop picker UI", () => {
    const files = [
      { path: "/repo/src/add.ts", name: "add.ts", size: 900, insideWorkspace: true, relativePath: "src/add.ts" },
      { path: "/tmp/photo.PNG", name: "photo.PNG", size: 2048, insideWorkspace: false },
      { path: "/tmp/notes.txt", name: "notes.txt", size: 4096, insideWorkspace: false },
    ]

    const plan = planPickedFiles(files)

    expect(plan.workspaceFiles.map((file) => file.name)).toEqual(["add.ts"])
    expect(plan.images.map((file) => file.name)).toEqual(["photo.PNG"])
    expect(plan.rejectedFiles.map((file) => file.name)).toEqual(["notes.txt"])
  })

  test("turns picker results into real sidecar slash commands only", () => {
    const files = [
      { path: "/tmp/photo with spaces.PNG", name: "photo with spaces.PNG", size: 2048, insideWorkspace: false },
      { path: "/repo/src/add.ts", name: "add.ts", size: 900, insideWorkspace: true, relativePath: "src/add.ts" },
      { path: "/tmp/notes.txt", name: "notes.txt", size: 4096, insideWorkspace: false },
    ]

    expect(pickedFileSlashCommands(files)).toEqual({
      commands: ["/image /tmp/photo with spaces.PNG", "/file /repo/src/add.ts"],
      rejectedCount: 1,
    })
  })

  test("formats attachments and image slash commands consistently", () => {
    expect(isImageFile("screen.webp")).toBe(true)
    expect(isImageFile("src/add.ts")).toBe(false)
    expect(formatAttachmentBytes(500)).toBe("500 B")
    expect(formatAttachmentBytes(2048)).toBe("2 KB")
    expect(slashImageName("/tmp/screen.png", "label")).toBe("screen.png")
    expect(slashFileName("/repo/src/add.ts", "src/add.ts")).toBe("src/add.ts")
    expect(imageSlashCommand("/tmp/screen.png")).toBe("/image /tmp/screen.png")
    expect(fileSlashCommand("/repo/src/add.ts")).toBe("/file /repo/src/add.ts")
    expect(workspaceFileAttachment({ path: "/repo/src/add.ts", name: "add.ts", size: 2048, insideWorkspace: true }, "file_1")).toEqual({
      id: "file_1",
      kind: "file",
      name: "add.ts",
      path: "/repo/src/add.ts",
      size: "2 KB",
    })
    expect(imageAttachment("/tmp/screen.png", "label", "image_1")).toEqual({
      id: "image_1",
      kind: "image",
      name: "screen.png",
      path: "/tmp/screen.png",
      size: "image",
    })
    expect(fileAttachment("/repo/src/add.ts", "src/add.ts", "file_2")).toEqual({
      id: "file_2",
      kind: "file",
      name: "src/add.ts",
      path: "/repo/src/add.ts",
      size: "workspace",
    })
  })

  test("applies only real sidecar attachment actions to the UI list", () => {
    const current = [
      imageAttachment("/tmp/screen.png", "screen.png", "image_1"),
      fileAttachment("/repo/src/add.ts", "src/add.ts", "file_1"),
    ]

    expect(applyAttachmentAction(current, undefined, "ignored")).toBe(current)
    expect(applyAttachmentAction(current, { type: "addImage", path: "/tmp/new.png", label: "new.png" }, "image_2")).toEqual([
      ...current,
      imageAttachment("/tmp/new.png", "new.png", "image_2"),
    ])
    expect(applyAttachmentAction(current, { type: "addFile", path: "/repo/src/other.ts", label: "src/other.ts" }, "file_2")).toEqual([
      ...current,
      fileAttachment("/repo/src/other.ts", "src/other.ts", "file_2"),
    ])
    expect(applyAttachmentAction(current, { type: "clearImages" }, "unused")).toEqual([current[1]])
    expect(applyAttachmentAction(current, { type: "clearFiles" }, "unused")).toEqual([current[0]])
  })

  test("clears attachments through real sidecar slash commands", () => {
    expect(clearAttachmentSlashCommands([])).toEqual([])
    expect(clearAttachmentSlashCommands([
      imageAttachment("/tmp/screen.png", "screen.png", "image_1"),
    ])).toEqual(["/image clear"])
    expect(clearAttachmentSlashCommands([
      fileAttachment("/repo/src/add.ts", "src/add.ts", "file_1"),
    ])).toEqual(["/file clear"])
    expect(clearAttachmentSlashCommands([
      imageAttachment("/tmp/screen.png", "screen.png", "image_1"),
      fileAttachment("/repo/src/add.ts", "src/add.ts", "file_1"),
    ])).toEqual(["/image clear", "/file clear"])
  })

  test("removes workspace file references when attachments are removed", () => {
    expect(removeFileRefs("@/repo/src/add.ts\nplease inspect\n@/repo/src/other.ts", ["/repo/src/add.ts"])).toBe("please inspect\n@/repo/src/other.ts")
    expect(rejectedWorkspaceFileSummary(2)).toBe("Skipped 2 files outside the workspace. Add workspace files or attach external content as images.")
  })
})
