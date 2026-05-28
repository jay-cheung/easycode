import path from "node:path"

export const repoMapGeneratorVersion = "1"
export const codeIndexGeneratorVersion = "4"
export const defaultMaxResults = 50
export const maxMaxResults = 200
export const defaultReadLineLimit = 200
export const repoMapCachePath = path.join(".easycode", "cache", "repo-map.json")
export const codeIndexCachePath = path.join(".easycode", "cache", "code-index", "index.json")
export const ignoredDirs = new Set([".git", "node_modules", ".easycode", "dist", "build", "coverage"])
export const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".php", ".rb"])
