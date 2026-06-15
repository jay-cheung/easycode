// Default configuration values for AgentRunner
export const defaultToolProgressIntervalMs = 10_000
export const defaultProviderProgressIntervalMs = 10_000
export const maxAutoSkillArtifactInspections = 3

// Auto-inspection file extensions
export const autoInspectFileExtensions = new Set([
  ".bash",
  ".cjs",
  ".conf",
  ".cts",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".prompt",
  ".py",
  ".sh",
  ".sql",
  ".tmpl",
  ".toml",
  ".tpl",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
  ".zsh",
])
export const autoInspectFileBasenames = new Set(["Dockerfile", "Makefile", "justfile"])
export const autoInspectIgnoredBasenames = new Set(["Cargo.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"])
export const autoInspectIgnoredDirectories = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"])

// Memory recall
export const autoRecallMemoryKinds = ["session_archive", "preference", "repo_fact", "failure_pattern", "successful_workflow"] as const
export const maxAutoRecalledMemoryRecords = 3
