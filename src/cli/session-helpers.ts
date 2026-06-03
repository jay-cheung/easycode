import { stdout as output } from "node:process"
import { imageLabel, imagePartFromInput } from "../image"
import type { AgentMode, ImagePart } from "../message"
import { defaultPermissionAutoReviewer, defaultPermissionRules, PermissionService, type PermissionRequest } from "../permission"
import { createProvider, defaultProviderCapabilities, hasProvider, listProviders } from "../provider"
import { hasConfiguredWebSearch, tavilySetupHint } from "../retrieval"
import { SessionStore } from "../session"
import { isReasoningEffort, type SessionSettings } from "../settings"
import { parseSlashCommand, slashHelpText, type SlashCommand } from "../slash"
import { SkillService } from "../skill"
import { TuiRenderer } from "../ui/tui"
import { eofPrompt, LineReader } from "./line-reader"

export async function maybeShowWebSearchSetupHint(root: string, tui?: TuiRenderer) {
  if (await hasConfiguredWebSearch(root, process.env)) return
  writeCliText(tui, `Live web search is not configured.\n${tavilySetupHint}`, "Web Search")
}

export async function selectSession(explicitSession: string | undefined, store: SessionStore, reader: LineReader, tui?: TuiRenderer) {
  if (explicitSession) return explicitSession
  const sessions = await store.list()
  if (sessions.length === 0) {
    writeCliText(tui, "Starting new session: default", "Session")
    return "default"
  }
  const sessionLines = [
    "Select a session:",
    ...sessions.map((session, index) => `  ${index + 1}. ${session.id}${session.messageCount ? ` (${session.messageCount} messages)` : ""}`),
    "Press Enter for 1, enter a number, or type a new session id.",
  ]
  writeCliText(tui, sessionLines.join("\n"), "Sessions")
  while (true) {
    const answer = (await reader.question(tui?.sessionPrompt() ?? "session> ")).trim()
    if (answer === eofPrompt) return undefined
    if (!answer) return sessions[0].id
    const selectedIndex = Number(answer)
    if (Number.isInteger(selectedIndex)) {
      if (selectedIndex >= 1 && selectedIndex <= sessions.length) return sessions[selectedIndex - 1].id
      writeCliText(tui, `Choose 1-${sessions.length}, or type a non-numeric new session id.`, "Sessions")
      continue
    }
    return answer
  }
}

export async function handleSlashCommand(command: Exclude<SlashCommand, { type: "prompt" }>, input: { root: string; settings: SessionSettings; pendingImages: ImagePart[]; skills: SkillService; sessions?: SessionStore; currentSession?: string; tui?: TuiRenderer }) {
  const next = { ...input.settings, selectedSkills: [...input.settings.selectedSkills] }
  let pendingImages = input.pendingImages
  let resetRunner = false
  input.tui?.slashCommand(command.type)
  const write = (text: string, title = "Command") => writeCliText(input.tui, text, title)
  switch (command.type) {
    case "help":
      write(slashHelpText(), "Help")
      break
    case "settings":
      write(settingsText(next, pendingImages), "Settings")
      break
    case "sessions":
      write(await sessionsText(input.sessions, input.currentSession), "Sessions")
      break
    case "unknown":
      write(`Unknown command: /${command.name}. Use /help.`, "Command")
      break
    case "error":
      write(command.message, "Command")
      break
    case "model":
      next.model = command.model
      resetRunner = true
      write(`Model set to ${next.model}`, "Model")
      break
    case "provider":
      if (!hasProvider(command.name)) write(`Unknown provider: ${command.name}. Available providers: ${listProviders().join(", ")}`, "Provider")
      else {
        next.provider = command.name
        next.model = undefined
        resetRunner = true
        write(`Provider set to ${next.provider}`, "Provider")
      }
      break
    case "thinking": {
      const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
      if (!(provider.capabilities ?? defaultProviderCapabilities).supportsThinking) write(`Provider ${next.provider} does not support thinking controls.`, "Thinking")
      else {
        next.thinking = command.value === "on"
        resetRunner = true
        write(`${command.aliasUsed ? "Alias /thingking accepted; use /thinking next time. " : ""}Thinking ${next.thinking ? "on" : "off"}.`, "Thinking")
      }
      break
    }
    case "effort": {
      if (!isReasoningEffort(command.value)) write("/effort requires low, medium, high, or max", "Effort")
      else {
        const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
        if (!(provider.capabilities ?? defaultProviderCapabilities).supportsReasoningEffort) write(`Provider ${next.provider} does not support effort controls.`, "Effort")
        else {
          next.effort = command.value
          resetRunner = true
          write(`Effort set to ${next.effort}${next.thinking ? "" : " (applies when /thinking is on)"}.`, "Effort")
        }
      }
      break
    }
    case "image": {
      if (command.action === "clear") {
        pendingImages = []
        write("Pending images cleared.", "Image")
      } else {
        const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
        if (!(provider.capabilities ?? defaultProviderCapabilities).supportsImages) write(`Provider ${next.provider} does not support image input. Use /model openai with a vision-capable model.`, "Image")
        else {
          try {
            const part = await imagePartFromInput(command.value, input.root)
            pendingImages = [...pendingImages, part]
            write(`Attached image: ${imageLabel(part.source)}`, "Image")
          } catch (error) {
            write(error instanceof Error ? error.message : String(error), "Image")
          }
        }
      }
      break
    }
    case "skill": {
      if (command.action === "list") {
        const skills = await input.skills.available()
        const lines: string[] = []
        for (const skill of skills) {
          lines.push(`${skill.id}\n  name: ${skill.name} — ${skill.description}`)
        }
        write(skills.length === 0 ? "No skills found." : lines.join("\n"), "Skills")
      }
      if (command.action === "clear") {
        next.selectedSkills = []
        next.pendingSkillLoads = []
        resetRunner = true
        write("Active skills cleared.", "Skills")
      }
      if (command.action === "use") {
        const skill = await input.skills.load(command.name)
        if (!skill) write(`Skill not found: ${command.name}`, "Skills")
        else {
          next.selectedSkills = [...new Set([...next.selectedSkills, skill.id])]
          next.pendingSkillLoads = [...new Set([...(next.pendingSkillLoads ?? []), skill.id])]
          resetRunner = true
          write(`Skill active: ${skill.id}`, "Skills")
        }
      }
      if (command.action === "remove") {
        const removed = next.selectedSkills.filter((id) => id === command.name || id.endsWith(`/${command.name}`) || id.endsWith(`:${command.name}`))
        if (removed.length === 0) {
          write(`No active skill found: ${command.name}`, "Skills")
        } else {
          next.selectedSkills = next.selectedSkills.filter((id) => !removed.includes(id))
          next.pendingSkillLoads = (next.pendingSkillLoads ?? []).filter((id) => !removed.includes(id))
          resetRunner = true
          write(`Skill removed: ${removed.join(", ")}`, "Skills")
        }
      }
      break
    }
  }
  return { settings: next, pendingImages, resetRunner }
}

export async function sessionsText(store: SessionStore | undefined, currentSession: string | undefined) {
  if (!store) return "No session store is active."
  const sessions = await store.list()
  if (sessions.length === 0) return "No saved sessions."
  return [
    "Saved sessions:",
    ...sessions.map((session, index) => {
      const current = session.id === currentSession ? " (current)" : ""
      const messages = session.messageCount === 1 ? "1 message" : `${session.messageCount} messages`
      return `  ${index + 1}. ${session.id}${current} - ${messages}`
    }),
  ].join("\n")
}

export function settingsText(settings: SessionSettings, images: ImagePart[]) {
  return [
    `provider: ${settings.provider}`,
    `model: ${settings.model ?? "(provider default)"}`,
    `thinking: ${settings.thinking ? "on" : "off"}`,
    `effort: ${settings.effort}`,
    "cache: every-step",
    `maxTokens: ${settings.maxTokens}`,
    `maxSteps: ${settings.maxSteps}`,
    `skills: ${settings.selectedSkills.join(", ") || "(none)"}`,
    `pendingSkillLoads: ${settings.pendingSkillLoads.join(", ") || "(none)"}`,
    `pending images: ${images.length}`,
  ].join("\n")
}

export function writeCliText(tui: TuiRenderer | undefined, text: string, title: string) {
  if (tui) {
    tui.panel(title, text)
    return
  }
  output.write(text.endsWith("\n") ? text : `${text}\n`)
}

export function collectRunInput(reader: LineReader, activeAbort: AbortController, queuedPrompts: string[], tui?: TuiRenderer) {
  const pumpAbort = new AbortController()
  if (tui) tui.runInputHint()
  else output.write("Type /cancel to stop this run; other input will run next.\n")
  const done = (async () => {
    while (!pumpAbort.signal.aborted) {
      const line = await reader.nextLine("background", pumpAbort.signal)
      if (line === eofPrompt) break
      const text = line.trim()
      if (!text) continue
      if (isCancelInput(text)) {
        if (tui) tui.cancelling()
        else output.write("Cancelling current run...\n")
        activeAbort.abort()
        pumpAbort.abort()
        break
      }
      queuedPrompts.push(text)
      if (tui) tui.queued(shortPrompt(text))
      else output.write(`Queued next input: ${shortPrompt(text)}\n`)
    }
  })()
  return {
    stop: () => {
      pumpAbort.abort()
      void done
    },
  }
}

export async function question(reader: LineReader, tui?: TuiRenderer) {
  return reader.question(tui?.inputPrompt() ?? "> ")
}

export function permissionService(mode: AgentMode, reader: LineReader, cancelRun?: () => void, tui?: TuiRenderer) {
  return new PermissionService(defaultPermissionRules(mode), async (request) => {
    const basePrompt = permissionPrompt(request)
    const answer = (await questionWithPrompt(reader, tui?.permissionPrompt(request, basePrompt) ?? basePrompt)).trim().toLowerCase()
    tui?.resumeAfterPrompt()
    if (answer === eofPrompt) return "reject"
    if (isCancelInput(answer)) {
      cancelRun?.()
      if (tui) tui.cancelling()
      else output.write("Cancelling current run...\n")
      return "reject"
    }
    if (answer === "a" || answer === "always") return "always"
    if (answer === "" || answer === "y" || answer === "yes" || answer === "once") return "once"
    return "reject"
  }, defaultPermissionAutoReviewer)
}

function isCancelInput(text: string) {
  return ["/cancel", "cancel", ":cancel", "stop", "/stop"].includes(text.trim().toLowerCase())
}

function shortPrompt(text: string) {
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`
}

function permissionPrompt(request: PermissionRequest) {
  const patterns = request.patterns.join(", ")
  const scope = typeof request.metadata.approvalScope === "string" ? `\nScope: ${request.metadata.approvalScope}` : ""
  if (request.permission === "bash" && typeof request.metadata.command === "string") {
    return `Allow bash for ${request.metadata.command}?${scope}\n[Y]es/[a]lways/[n]o`
  }
  if (request.permission === "sandbox_bypass") {
    const risk = typeof request.metadata.risk === "string" ? request.metadata.risk : "This command will be retried without the native write sandbox."
    const reason = typeof request.metadata.reason === "string" ? `Reason: ${request.metadata.reason}\n` : ""
    const command = typeof request.metadata.command === "string" ? request.metadata.command : patterns
    const failure = typeof request.metadata.failure === "string" && request.metadata.failure ? `\nFailure: ${request.metadata.failure}` : ""
    return `EasyCode sandbox blocked this command.
${reason}Risk: ${risk}
Command: ${command}${scope}${failure}
Allow sandbox bypass for this command? [Y]es/[a]lways/[n]o`
  }
  return `Allow ${request.permission} for ${patterns}? [Y]es/[a]lways/[n]o`
}

async function questionWithPrompt(reader: LineReader, prompt: string) {
  output.write(`${prompt}\n`)
  return reader.question("permission> ")
}

export function promptToCommand(prompt: string) {
  return parseSlashCommand(prompt)
}
