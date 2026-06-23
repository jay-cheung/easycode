import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
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
} finally {
  rmSync(temp, { recursive: true, force: true })
}
