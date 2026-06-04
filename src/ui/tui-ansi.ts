export function ensureTrailingNewline(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`
}

export function compactPath(input: string, width: number) {
  if (input.length <= width) return input
  const tail = input.slice(Math.max(0, input.length - width + 3))
  return `...${tail}`
}

export function displayWidth(text: string) {
  let width = 0
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += isWideCharacter(char) ? 2 : 1
  }
  return width
}

export function truncateToWidth(text: string, width: number): string {
  let visibleLen = 0
  let result = ""
  let inEscape = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === "\x1b") {
      inEscape = true
      result += char
      continue
    }
    if (inEscape) {
      result += char
      if (char === "m") {
        inEscape = false
      }
      continue
    }

    const charWidth = isWideCharacter(char) ? 2 : 1
    if (visibleLen + charWidth + 3 > width) {
      result += "..."
      result += "\x1b[0m"
      break
    }
    result += char
    visibleLen += charWidth
  }
  return result
}

export function drawCard(
  title: string,
  lines: string[],
  maxColumns: number,
  options: {
    color?: string
    borderStyle?: "single" | "double" | "round"
    minWidth?: number
  } = {},
): string {
  const color = options.color ?? "\x1b[36m"
  const borderStyle = options.borderStyle ?? "single"
  const minWidth = options.minWidth ?? 60
  const maxContentLength = lines.reduce((max, line) => Math.max(max, displayWidth(line)), 0)
  const headerMinLength = title.length + 8
  const columns = Math.max(
    minWidth,
    Math.min(
      maxColumns,
      Math.max(maxContentLength + 4, headerMinLength),
    ),
  )

  const chars = {
    single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
    double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
    round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  }[borderStyle]

  const maxLineWidth = columns - 4
  const titledHeader = ` [${title}] `
  const headerLeft = chars.h.repeat(2)
  const headerRight = chars.h.repeat(Math.max(0, columns - titledHeader.length - 4))
  const topBorder = `${color}${chars.tl}${headerLeft}${titledHeader}${headerRight}${chars.tr}\x1b[0m`

  const formattedLines = lines.map((line) => {
    const visibleLength = displayWidth(line)
    if (visibleLength <= maxLineWidth) {
      return `${color}${chars.v}\x1b[0m ${line}${" ".repeat(maxLineWidth - visibleLength)} ${color}${chars.v}\x1b[0m`
    }
    const truncated = truncateToWidth(line, maxLineWidth)
    const truncatedVisible = displayWidth(truncated)
    return `${color}${chars.v}\x1b[0m ${truncated}${" ".repeat(maxLineWidth - truncatedVisible)} ${color}${chars.v}\x1b[0m`
  })

  const bottomBorder = `${color}${chars.bl}${chars.h.repeat(columns - 2)}${chars.br}\x1b[0m`

  return [topBorder, ...formattedLines, bottomBorder].join("\n")
}

export function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s"
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`
  const seconds = durationMs / 1_000
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`
  return `${Math.round(seconds)}s`
}

function isWideCharacter(char: string) {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}
