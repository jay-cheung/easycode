import { codeExtensions, defaultMaxResults, maxMaxResults } from "./constants"

export function normalizeMaxResults(value: number | undefined) {
  return clampInt(value ?? defaultMaxResults, 1, maxMaxResults)
}

export function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function fileTypeArgs(fileType: string | undefined) {
  if (!fileType) return []
  const normalized = fileType.replace(/^\./, "")
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) throw new Error("fileType must be a simple extension or rg type name")
  return ["--glob", `*.${normalized}`]
}

export function definitionPatterns(symbol: string) {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) throw new Error("symbol must be a valid identifier")
  return [
    `export function ${symbol}($$$) { $$$ }`,
    `function ${symbol}($$$) { $$$ }`,
    `export async function ${symbol}($$$) { $$$ }`,
    `async function ${symbol}($$$) { $$$ }`,
    `export class ${symbol} { $$$ }`,
    `class ${symbol} { $$$ }`,
    `export interface ${symbol} { $$$ }`,
    `interface ${symbol} { $$$ }`,
    `export type ${symbol} = $$$`,
    `type ${symbol} = $$$`,
    `export const ${symbol} = $$$`,
    `const ${symbol} = $$$`,
    `export let ${symbol} = $$$`,
    `let ${symbol} = $$$`,
    `export var ${symbol} = $$$`,
    `var ${symbol} = $$$`,
  ]
}

export function languageToFileType(language: string | undefined) {
  if (!language) return undefined
  if (language === "typescript") return "ts"
  if (language === "javascript") return "js"
  return language
}

export function extensionsForLanguage(language: string | undefined) {
  if (language === "typescript") return new Set([".ts", ".tsx"])
  if (language === "javascript") return new Set([".js", ".jsx", ".mjs", ".cjs"])
  return codeExtensions
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
