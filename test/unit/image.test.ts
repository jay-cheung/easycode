import { describe, expect, test } from "bun:test"
import { imageLabel } from "../../src/image"

describe("image attachments", () => {
  test("uses compact display labels for local images and urls", () => {
    expect(imageLabel({ type: "path", path: "/repo/screens/screen shot.png", mimeType: "image/png" })).toBe("screen shot.png")
    expect(imageLabel({ type: "url", url: "https://example.test/screen.png" })).toBe("https://example.test/screen.png")
  })
})
