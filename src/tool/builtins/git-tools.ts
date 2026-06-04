import { GitBranchInput, GitCommitInput, GitDiffInput, GitLogInput, GitRestoreInput, GitStageInput, GitStatusInput, gitBranchToolResult, gitCommitToolResult, gitDiffToolResult, gitLogToolResult, gitRestoreToolResult, gitStageToolResult, gitStatusToolResult } from "../git"
import { scopedBashApproval } from "../bash"
import type { ToolRegistry } from "../registry"
import { objectSchema } from "./common"

export function registerGitTools(registry: ToolRegistry) {
  registry.register({
    name: "git_diff",
    description: "Inspect git changes without dumping full patches. Use summary/files/stat first; use mode=file with one filePath only when a focused patch is needed.",
    inputSchema: GitDiffInput,
    jsonSchema: objectSchema(
      {
        mode: { type: "string", description: "summary, files, stat, or file. Defaults to summary." },
        filePath: { type: "string", description: "Required only for mode=file. Project-relative path to inspect." },
        maxBytes: { type: "number", description: "Maximum patch bytes for mode=file. Defaults to 12000 and is capped at 30000." },
      },
      [],
    ),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:diff", "project", []).target],
    execute: async (input, ctx) => gitDiffToolResult(GitDiffInput.parse(input), ctx),
  })

  registry.register({
    name: "git_status",
    description: "Inspect git status without full patches.",
    inputSchema: GitStatusInput,
    jsonSchema: objectSchema({ short: { type: "boolean", description: "Use short branch status." } }, []),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:status", "project", []).target],
    execute: async (input, ctx) => gitStatusToolResult(GitStatusInput.parse(input), ctx),
  })

  registry.register({
    name: "git_stage",
    description: "Stage only explicit project files.",
    inputSchema: GitStageInput,
    jsonSchema: objectSchema({ files: { type: "array", items: { type: "string" }, description: "Project-relative files to stage." } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("git:stage", "explicit-files", []).target],
    execute: async (input, ctx) => gitStageToolResult(GitStageInput.parse(input), ctx),
  })

  registry.register({
    name: "git_commit",
    description: "Stage and commit only explicit files; refuses unrelated staged files.",
    inputSchema: GitCommitInput,
    jsonSchema: objectSchema({ message: { type: "string" }, files: { type: "array", items: { type: "string" } } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("git:commit", "explicit-files", []).target],
    execute: async (input, ctx) => gitCommitToolResult(GitCommitInput.parse(input), ctx),
  })

  registry.register({
    name: "git_branch",
    description: "Show current branch or create one explicitly.",
    inputSchema: GitBranchInput,
    jsonSchema: objectSchema({ name: { type: "string" }, create: { type: "boolean" }, startPoint: { type: "string" } }, []),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:branch", "project", []).target],
    execute: async (input, ctx) => gitBranchToolResult(GitBranchInput.parse(input), ctx),
  })

  registry.register({
    name: "git_log",
    description: "Inspect recent commit history.",
    inputSchema: GitLogInput,
    jsonSchema: objectSchema({ limit: { type: "number", description: "Maximum commits, capped at 50." } }, []),
    permission: "bash",
    modes: ["build", "plan"],
    patterns: () => [scopedBashApproval("git:log", "project", []).target],
    execute: async (input, ctx) => gitLogToolResult(GitLogInput.parse(input), ctx),
  })

  registry.register({
    name: "git_restore_guarded",
    description: "Restore only explicit files from index or worktree.",
    inputSchema: GitRestoreInput,
    jsonSchema: objectSchema({ files: { type: "array", items: { type: "string" } }, staged: { type: "boolean" }, worktree: { type: "boolean" } }),
    permission: "bash",
    modes: ["build"],
    patterns: () => [scopedBashApproval("git:restore", "explicit-files", []).target],
    execute: async (input, ctx) => gitRestoreToolResult(GitRestoreInput.parse(input), ctx),
  })
}
