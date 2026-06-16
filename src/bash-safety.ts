export type BashSafetyAction = "allow" | "review" | "deny"

export type BashSafetyDecision = {
  action: BashSafetyAction
  reason: string
  riskTags: string[]
  reviewContext?: string
}

export function classifyBashSafety(input: { command: string }): BashSafetyDecision {
  const command = input.command.trim()
  const normalized = command.replace(/\s+/g, " ").trim()
  if (!normalized) return { action: "allow", reason: "empty command", riskTags: [] }
  if (isFileDeletionCommand(normalized)) return { action: "deny", reason: "file deletion command", riskTags: ["file_deletion"] }
  if (isGitRemoteCommand(normalized)) return { action: "deny", reason: "git remote command", riskTags: ["git_remote"] }

  const risks: string[] = []
  if (isSudoCommand(normalized)) risks.push("sudo")
  if (isDockerCommand(normalized)) risks.push("docker")
  if (isDownloadPipeShellCommand(normalized)) risks.push("remote_script_execution")
  if (isPackageMutationCommand(normalized)) risks.push("package_mutation")
  if (isPermissionMutationCommand(normalized)) risks.push("permission_mutation")
  if (isBackgroundProcessCommand(normalized)) risks.push("background_process")
  if (containsSensitivePath(normalized)) risks.push("sensitive_path")
  if (isNetworkUploadOrSyncCommand(normalized)) risks.push("network_upload_or_sync")
  if (risks.length > 0) {
    return {
      action: "review",
      reason: `high risk bash command: ${risks.join(", ")}`,
      riskTags: risks,
      reviewContext: normalized,
    }
  }
  return { action: "allow", reason: "ordinary bash command", riskTags: [] }
}

export function isHardDeniedBashCommand(command: string) {
  const decision = classifyBashSafety({ command })
  return decision.action === "deny"
}

export function containsSensitivePath(value: string) {
  const normalized = value.replaceAll("\\", "/").toLowerCase()
  return /(^|[/\s"'=])\.env(?:[^/\s"'=]*)?(?:[/\s"'=]|$)/.test(normalized) || /(^|[/\s"'=])secrets?(?:[/\s"'=]|$)/.test(normalized)
}

function commandBoundary(program: string) {
  return new RegExp(`(^|[;&|]\\s*)(?:command\\s+)?${program}\\b`, "i")
}

function isFileDeletionCommand(command: string) {
  return commandBoundary("(?:rm|rmdir|unlink|trash)").test(command)
    || /(^|[;&|]\s*)find\b[\s\S]*\s-delete(?:\s|$)/i.test(command)
    || /(^|[;&|]\s*)git\s+clean\b/i.test(command)
}

function isGitRemoteCommand(command: string) {
  return /(^|[;&|]\s*)git\s+(?:push|pull|fetch|clone|remote|ls-remote)\b/i.test(command)
    || /(^|[;&|]\s*)git\s+submodule\b[\s\S]*\s--remote(?:\s|$)/i.test(command)
}

function isSudoCommand(command: string) {
  return commandBoundary("sudo").test(command)
}

function isDockerCommand(command: string) {
  return commandBoundary("(?:docker|podman|colima)").test(command)
}

function isDownloadPipeShellCommand(command: string) {
  const text = command.toLowerCase()
  return /\b(curl|wget)\b[\s\S]*\|[\s\S]*(?:\b(?:sh|bash|source)\b|\/bin\/(?:sh|bash)\b)/.test(text)
}

function isPackageMutationCommand(command: string) {
  return /(^|[;&|]\s*)(?:bun|npm|pnpm|yarn|pip|pip3|uv|cargo|go)\s+(?:install|add|update|get|dlx|create)\b/i.test(command)
}

function isPermissionMutationCommand(command: string) {
  return /(^|[;&|]\s*)(?:chmod|chown|chgrp)\b/i.test(command)
}

function isBackgroundProcessCommand(command: string) {
  return /(^|[;&|]\s*)(?:nohup|setsid|disown)\b/i.test(command) || /(?:^|[^&])&\s*(?:$|[;)]|\bdisown\b)/.test(command)
}

function isNetworkUploadOrSyncCommand(command: string) {
  return /(^|[;&|]\s*)(?:scp|rsync|ssh|sftp)\b/i.test(command)
    || /(^|[;&|]\s*)curl\b[\s\S]*(?:\s-T\s|\s--upload-file\b|\s-d\s|\s--data(?:-raw|-binary|-urlencode)?\b|\s-F\s|\s--form\b)/i.test(command)
    || /(^|[;&|]\s*)wget\b[\s\S]*(?:\s--post-data\b|\s--post-file\b)/i.test(command)
}
