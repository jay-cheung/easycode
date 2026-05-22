import path from "node:path"

export const repoMapGeneratorVersion = "1"
export const defaultMaxResults = 50
export const maxMaxResults = 200
export const defaultReadLineLimit = 200
export const repoMapCachePath = path.join(".easycode", "cache", "repo-map.json")
export const ignoredDirs = new Set([".git", "node_modules", ".easycode", "dist", "build", "coverage"])
export const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
