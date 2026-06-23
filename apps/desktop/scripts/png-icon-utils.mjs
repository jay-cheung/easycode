import { deflateSync, inflateSync } from "node:zlib"

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const crcTable = makeCrcTable()

export function parseRgbaPng(buffer) {
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("Invalid PNG signature.")

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatChunks = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("ascii", offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error("Interlaced PNG icons are not supported.")
    } else if (type === "IDAT") {
      idatChunks.push(data)
    } else if (type === "IEND") {
      break
    }
  }

  if (bitDepth !== 8 || colorType !== 6) throw new Error("Icon source must be an 8-bit RGBA PNG.")
  const pixels = unfilterRgba(inflateSync(Buffer.concat(idatChunks)), width, height)
  return { width, height, pixels }
}

export function resizeRgba(image, size) {
  if (image.width === size && image.height === size) return Buffer.from(image.pixels)

  const output = Buffer.alloc(size * size * 4)
  const scaleX = image.width / size
  const scaleY = image.height / size

  for (let y = 0; y < size; y++) {
    const sourceY = (y + 0.5) * scaleY - 0.5
    const y0 = clamp(Math.floor(sourceY), 0, image.height - 1)
    const y1 = clamp(y0 + 1, 0, image.height - 1)
    const fy = sourceY - y0

    for (let x = 0; x < size; x++) {
      const sourceX = (x + 0.5) * scaleX - 0.5
      const x0 = clamp(Math.floor(sourceX), 0, image.width - 1)
      const x1 = clamp(x0 + 1, 0, image.width - 1)
      const fx = sourceX - x0
      const mixed = mixPixels(image.pixels, image.width, x0, y0, x1, y1, fx, fy)
      const index = (y * size + x) * 4
      output[index] = mixed[0]
      output[index + 1] = mixed[1]
      output[index + 2] = mixed[2]
      output[index + 3] = mixed[3]
    }
  }

  return output
}

export function encodeRgbaPng(width, height, pixels) {
  const scanlineLength = width * 4
  const raw = Buffer.alloc((scanlineLength + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (scanlineLength + 1)] = 0
    pixels.copy(raw, y * (scanlineLength + 1) + 1, y * scanlineLength, (y + 1) * scanlineLength)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function unfilterRgba(raw, width, height) {
  const bytesPerPixel = 4
  const rowLength = width * bytesPerPixel
  const pixels = Buffer.alloc(rowLength * height)
  let inputOffset = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[inputOffset++]
    const rowOffset = y * rowLength
    const previousOffset = rowOffset - rowLength

    for (let x = 0; x < rowLength; x++) {
      const source = raw[inputOffset++]
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0
      const up = y > 0 ? pixels[previousOffset + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[previousOffset + x - bytesPerPixel] : 0
      pixels[rowOffset + x] = (source + filterValue(filter, left, up, upLeft)) & 255
    }
  }

  return pixels
}

function filterValue(filter, left, up, upLeft) {
  if (filter === 0) return 0
  if (filter === 1) return left
  if (filter === 2) return up
  if (filter === 3) return Math.floor((left + up) / 2)
  if (filter === 4) {
    const guess = left + up - upLeft
    const leftDistance = Math.abs(guess - left)
    const upDistance = Math.abs(guess - up)
    const upLeftDistance = Math.abs(guess - upLeft)
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
    return upDistance <= upLeftDistance ? up : upLeft
  }
  throw new Error(`Unsupported PNG filter: ${filter}`)
}

function mixPixels(pixels, width, x0, y0, x1, y1, fx, fy) {
  const a = premultipliedPixel(pixels, width, x0, y0)
  const b = premultipliedPixel(pixels, width, x1, y0)
  const c = premultipliedPixel(pixels, width, x0, y1)
  const d = premultipliedPixel(pixels, width, x1, y1)
  const top = mixPremultiplied(a, b, fx)
  const bottom = mixPremultiplied(c, d, fx)
  const mixed = mixPremultiplied(top, bottom, fy)
  if (mixed.a <= 0.0001) return [0, 0, 0, 0]
  return [
    clampByte(mixed.r / mixed.a),
    clampByte(mixed.g / mixed.a),
    clampByte(mixed.b / mixed.a),
    clampByte(mixed.a * 255),
  ]
}

function premultipliedPixel(pixels, width, x, y) {
  const index = (y * width + x) * 4
  const a = pixels[index + 3] / 255
  return {
    r: pixels[index] * a,
    g: pixels[index + 1] * a,
    b: pixels[index + 2] * a,
    a,
  }
}

function mixPremultiplied(a, b, amount) {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
    a: a.a + (b.a - a.a) * amount,
  }
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  const crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function makeCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    return value >>> 0
  })
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function clampByte(value) {
  return clamp(Math.round(value), 0, 255)
}
