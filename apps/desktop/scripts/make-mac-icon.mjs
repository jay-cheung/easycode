import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { encodeRgbaPng, parseRgbaPng, resizeRgba } from "./png-icon-utils.mjs"

const root = path.resolve(import.meta.dirname, "..")
const source = path.join(root, "build", "icon.png")
const output = path.join(root, "build", "icon.icns")

if (!existsSync(source)) throw new Error(`Missing icon source: ${source}`)
mkdirSync(path.dirname(output), { recursive: true })

const temp = mkdtempSync(path.join(tmpdir(), "easycode-icon-"))
const icon = parseRgbaPng(readFileSync(source))
const entries = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 512],
  ["ic14", 1024],
]

try {
  const wroteNative = process.platform === "darwin" && writeNativeIcns(temp, icon)
  if (!wroteNative) {
    const chunks = []
    let totalLength = 8
    for (const [type, size] of entries) {
      const resized = path.join(temp, `${size}.png`)
      const pixels = resizeRgba(icon, size)
      writeFileSync(resized, encodeRgbaPng(size, size, pixels))
      const data = readFileSync(resized)
      const header = Buffer.alloc(8)
      header.write(type, 0, 4, "ascii")
      header.writeUInt32BE(data.length + 8, 4)
      chunks.push(header, data)
      totalLength += header.length + data.length
    }

    const fileHeader = Buffer.alloc(8)
    fileHeader.write("icns", 0, 4, "ascii")
    fileHeader.writeUInt32BE(totalLength, 4)
    writeFileSync(output, Buffer.concat([fileHeader, ...chunks], totalLength))
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

function writeNativeIcns(temp, icon) {
  const iconset = path.join(temp, "EasyCode.iconset")
  mkdirSync(iconset, { recursive: true })
  const iconsetEntries = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]
  for (const [filename, size] of iconsetEntries) {
    writeFileSync(path.join(iconset, filename), encodeRgbaPng(size, size, resizeRgba(icon, size)))
  }
  const result = spawnSync("iconutil", ["-c", "icns", "-o", output, iconset], { stdio: "pipe" })
  return result.status === 0 && existsSync(output)
}
