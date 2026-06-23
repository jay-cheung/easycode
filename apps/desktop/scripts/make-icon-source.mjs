import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { encodeRgbaPng, resizeRgba } from "./png-icon-utils.mjs"

const root = path.resolve(import.meta.dirname, "..")
const output = path.join(root, "build", "icon.png")
const size = 1024
const scale = 3
const canvasSize = size * scale
const pixels = Buffer.alloc(canvasSize * canvasSize * 4)

drawIcon()
mkdirSync(path.dirname(output), { recursive: true })
writeFileSync(output, encodeRgbaPng(size, size, resizeRgba({ width: canvasSize, height: canvasSize, pixels }, size)))

function drawIcon() {
  const s = scale
  drawRoundedRect(116 * s, 110 * s, 792 * s, 792 * s, 188 * s, gradientFill("#16243f", "#3453b3"), 1)
  drawRoundedRectStroke(138 * s, 132 * s, 748 * s, 748 * s, 166 * s, 8 * s, [184, 200, 255, 60])
  drawRoundedRectStroke(166 * s, 160 * s, 692 * s, 692 * s, 140 * s, 4 * s, [255, 255, 255, 34])

  drawLine(237 * s, 446 * s, 158 * s, 512 * s, 44 * s, [110, 224, 255, 255])
  drawLine(158 * s, 512 * s, 237 * s, 578 * s, 44 * s, [110, 224, 255, 255])
  drawLine(787 * s, 446 * s, 866 * s, 512 * s, 44 * s, [156, 166, 255, 255])
  drawLine(866 * s, 512 * s, 787 * s, 578 * s, 44 * s, [156, 166, 255, 255])

  drawGlyphE(342 * s, 346 * s, s)
  drawGlyphC(565 * s, 346 * s, s)
  drawRoundedRect(682 * s, 702 * s, 154 * s, 34 * s, 17 * s, [154, 166, 255, 245], 1)
  drawRoundedRect(750 * s, 650 * s, 54 * s, 54 * s, 14 * s, [255, 255, 255, 240], 1)
}

function drawGlyphE(x, y, s) {
  const white = [255, 255, 255, 248]
  drawRoundedRect(x, y, 64 * s, 336 * s, 30 * s, white, 1)
  drawRoundedRect(x, y, 218 * s, 64 * s, 28 * s, white, 1)
  drawRoundedRect(x, y + 136 * s, 182 * s, 64 * s, 28 * s, white, 1)
  drawRoundedRect(x, y + 272 * s, 218 * s, 64 * s, 28 * s, white, 1)
}

function drawGlyphC(x, y, s) {
  const white = [255, 255, 255, 248]
  drawRoundedRect(x, y, 64 * s, 336 * s, 30 * s, white, 1)
  drawRoundedRect(x, y, 222 * s, 64 * s, 28 * s, white, 1)
  drawRoundedRect(x, y + 272 * s, 222 * s, 64 * s, 28 * s, white, 1)
}

function drawRoundedRect(x, y, w, h, r, fill, opacity) {
  const minX = Math.max(0, Math.floor(x - 2))
  const minY = Math.max(0, Math.floor(y - 2))
  const maxX = Math.min(canvasSize, Math.ceil(x + w + 2))
  const maxY = Math.min(canvasSize, Math.ceil(y + h + 2))
  for (let py = minY; py < maxY; py++) {
    for (let px = minX; px < maxX; px++) {
      const coverage = roundedRectCoverage(px + 0.5, py + 0.5, x, y, w, h, r)
      if (coverage <= 0) continue
      blendPixel(px, py, colorAt(fill, px, py), coverage * opacity)
    }
  }
}

function drawRoundedRectStroke(x, y, w, h, r, width, color) {
  const minX = Math.max(0, Math.floor(x - width - 2))
  const minY = Math.max(0, Math.floor(y - width - 2))
  const maxX = Math.min(canvasSize, Math.ceil(x + w + width + 2))
  const maxY = Math.min(canvasSize, Math.ceil(y + h + width + 2))
  for (let py = minY; py < maxY; py++) {
    for (let px = minX; px < maxX; px++) {
      const outer = roundedRectCoverage(px + 0.5, py + 0.5, x, y, w, h, r)
      const inner = roundedRectCoverage(px + 0.5, py + 0.5, x + width, y + width, w - width * 2, h - width * 2, Math.max(0, r - width))
      const coverage = Math.max(0, outer - inner)
      if (coverage > 0) blendPixel(px, py, color, coverage)
    }
  }
}

function drawLine(x1, y1, x2, y2, width, color) {
  const radius = width / 2
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - radius - 2))
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - radius - 2))
  const maxX = Math.min(canvasSize, Math.ceil(Math.max(x1, x2) + radius + 2))
  const maxY = Math.min(canvasSize, Math.ceil(Math.max(y1, y2) + radius + 2))
  for (let py = minY; py < maxY; py++) {
    for (let px = minX; px < maxX; px++) {
      const distance = distanceToSegment(px + 0.5, py + 0.5, x1, y1, x2, y2)
      const coverage = clamp(radius + 0.5 - distance, 0, 1)
      if (coverage > 0) blendPixel(px, py, color, coverage)
    }
  }
}

function roundedRectCoverage(px, py, x, y, w, h, r) {
  const cx = x + w / 2
  const cy = y + h / 2
  const qx = Math.abs(px - cx) - (w / 2 - r)
  const qy = Math.abs(py - cy) - (h / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return clamp(0.5 - (outside + inside - r), 0, 1)
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / lengthSquared, 0, 1)
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t))
}

function gradientFill(start, end) {
  const a = hexToRgb(start)
  const b = hexToRgb(end)
  return (x, y) => {
    const t = clamp((x * 0.35 + y * 0.65) / canvasSize, 0, 1)
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
      255,
    ]
  }
}

function colorAt(fill, x, y) {
  return typeof fill === "function" ? fill(x, y) : fill
}

function blendPixel(x, y, color, coverage) {
  const index = (y * canvasSize + x) * 4
  const sourceAlpha = (color[3] / 255) * coverage
  const targetAlpha = pixels[index + 3] / 255
  const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
  if (outAlpha <= 0) return
  pixels[index] = Math.round((color[0] * sourceAlpha + pixels[index] * targetAlpha * (1 - sourceAlpha)) / outAlpha)
  pixels[index + 1] = Math.round((color[1] * sourceAlpha + pixels[index + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha)
  pixels[index + 2] = Math.round((color[2] * sourceAlpha + pixels[index + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha)
  pixels[index + 3] = Math.round(outAlpha * 255)
}

function hexToRgb(hex) {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
