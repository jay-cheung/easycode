import { stdout as output } from "node:process"
import { languageDisplay, parseUiLanguage, supportedLanguageSummary, uiText } from "../i18n"
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
import { saveUiLanguagePreference } from "./startup"

export async function maybeShowWebSearchSetupHint(root: string, language: SessionSettings["language"], tui?: TuiRenderer) {
  if (await hasConfiguredWebSearch(root, process.env)) return
  const copy = uiText(language)
  writeCliText(tui, `${copy.webSearchNotConfigured}\n${tavilySetupHint}`, copy.webSearchTitle)
}

export async function selectSession(explicitSession: string | undefined, store: SessionStore, reader: LineReader, language: SessionSettings["language"], tui?: TuiRenderer) {
  const copy = uiText(language)
  if (explicitSession) return explicitSession
  const sessions = await store.list()
  if (sessions.length === 0) {
    writeCliText(tui, copy.startingNewSession("default"), copy.sessionTitle)
    return "default"
  }
  const sessionLines = [
    copy.selectSession,
    ...sessions.map((session, index) => `  ${index + 1}. ${session.id}${session.messageCount ? ` (${session.messageCount} messages)` : ""}`),
    copy.selectSessionHint,
  ]
  writeCliText(tui, sessionLines.join("\n"), copy.sessionsTitle)
  while (true) {
    const answer = (await reader.question(tui?.sessionPrompt() ?? copy.sessionPrompt)).trim()
    if (answer === eofPrompt) return undefined
    if (!answer) return sessions[0].id
    const selectedIndex = Number(answer)
    if (Number.isInteger(selectedIndex)) {
      if (selectedIndex >= 1 && selectedIndex <= sessions.length) return sessions[selectedIndex - 1].id
      writeCliText(tui, copy.selectSessionRange(sessions.length), copy.sessionsTitle)
      continue
    }
    return answer
  }
}

export async function handleSlashCommand(command: Exclude<SlashCommand, { type: "prompt" }>, input: { root: string; settings: SessionSettings; pendingImages: ImagePart[]; skills: SkillService; sessions?: SessionStore; currentSession?: string; tui?: TuiRenderer }) {
  const next = { ...input.settings, selectedSkills: [...input.settings.selectedSkills] }
  let pendingImages = input.pendingImages
  let resetRunner = false
  let goalAction: Extract<SlashCommand, { type: "goal" }> | undefined
  let sessionAction: { type: "switch" | "delete"; target: string } | undefined
  input.tui?.slashCommand(command.type)
  const write = (text: string, title?: string) => writeCliText(input.tui, text, title ?? uiText(next.language).commandTitle)

  switch (command.type) {
    case "help":
      write(slashHelpText(next.language), uiText(next.language).helpTitle)
      break
    case "settings":
      write(settingsText(next, pendingImages), uiText(next.language).settingsTitle)
      break
    case "goal":
      goalAction = command
      break
    case "sessions":
      write(await sessionsText(input.sessions, input.currentSession, next.language), uiText(next.language).sessionsTitle)
      break
    case "session":
      sessionAction = { type: command.action, target: command.target }
      break
    case "unknown":
      write(uiText(next.language).commandUnknown(command.name), uiText(next.language).commandTitle)
      break
    case "error":
      write(uiText(next.language).slashError(command.code), uiText(next.language).commandTitle)
      break
    case "model":
      next.model = command.model
      resetRunner = true
      write(uiText(next.language).modelSet(next.model), uiText(next.language).modelTitle)
      break
    case "provider":
      if (!hasProvider(command.name)) write(uiText(next.language).providerUnknown(command.name, listProviders().join(", ")), uiText(next.language).providerTitle)
      else {
        next.provider = command.name
        next.model = undefined
        resetRunner = true
        write(uiText(next.language).providerSet(next.provider), uiText(next.language).providerTitle)
      }
      break
    case "lang": {
      if (!command.value) {
        write(uiText(next.language).languageCurrent(languageDisplay(next.language), supportedLanguageSummary()), uiText(next.language).languageTitle)
        break
      }
      const selected = parseUiLanguage(command.value)
      if (!selected) {
        write(uiText(next.language).languageInvalid(command.value, supportedLanguageSummary()), uiText(next.language).languageTitle)
        break
      }
      next.language = selected
      input.tui?.configure({ language: next.language })
      const envPath = await saveUiLanguagePreference(next.language, process.env)
      write(uiText(next.language).languageUpdated(languageDisplay(next.language), envPath), uiText(next.language).languageTitle)
      break
    }
    case "thinking": {
      const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
      if (!(provider.capabilities ?? defaultProviderCapabilities).supportsThinking) write(uiText(next.language).providerThinkingUnsupported(next.provider), uiText(next.language).thinkingTitle)
      else {
        next.thinking = command.value === "on"
        resetRunner = true
        write(uiText(next.language).thinkingUpdated(next.thinking, Boolean(command.aliasUsed)), uiText(next.language).thinkingTitle)
      }
      break
    }
    case "effort": {
      if (!isReasoningEffort(command.value)) write(uiText(next.language).slashError("effort_requires_value"), uiText(next.language).effortTitle)
      else {
        const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
        if (!(provider.capabilities ?? defaultProviderCapabilities).supportsReasoningEffort) write(uiText(next.language).providerEffortUnsupported(next.provider), uiText(next.language).effortTitle)
        else {
          next.effort = command.value
          resetRunner = true
          write(uiText(next.language).effortUpdated(next.effort, next.thinking), uiText(next.language).effortTitle)
        }
      }
      break
    }
    case "image": {
      if (command.action === "clear") {
        pendingImages = []
        write(uiText(next.language).pendingImagesCleared, uiText(next.language).imageTitle)
      } else {
        const provider = createProvider(next.provider, { model: next.model, thinking: next.thinking, effort: next.effort })
        if (!(provider.capabilities ?? defaultProviderCapabilities).supportsImages) write(uiText(next.language).providerImageUnsupported(next.provider), uiText(next.language).imageTitle)
        else {
          try {
            const part = await imagePartFromInput(command.value, input.root)
            pendingImages = [...pendingImages, part]
            write(uiText(next.language).imageAttached(imageLabel(part.source)), uiText(next.language).imageTitle)
          } catch (error) {
            write(error instanceof Error ? error.message : String(error), uiText(next.language).imageTitle)
          }
        }
      }
      break
    }
    case "skill": {
      if (command.action === "list") {
        const skills = await input.skills.available()
        const lines: string[] = []
        for (const skill of skills) lines.push(`${skill.id}\n  name: ${skill.name} — ${skill.description}`)
        write(skills.length === 0 ? uiText(next.language).noSkillsFound : lines.join("\n"), uiText(next.language).skillsTitle)
      }
      if (command.action === "clear") {
        next.selectedSkills = []
        next.pendingSkillLoads = []
        resetRunner = true
        write(uiText(next.language).skillsCleared, uiText(next.language).skillsTitle)
      }
      if (command.action === "use") {
        const skill = await input.skills.load(command.name)
        if (!skill) write(uiText(next.language).skillNotFound(command.name), uiText(next.language).skillsTitle)
        else {
          next.selectedSkills = [...new Set([...next.selectedSkills, skill.id])]
          next.pendingSkillLoads = [...new Set([...(next.pendingSkillLoads ?? []), skill.id])]
          resetRunner = true
          write(uiText(next.language).skillActivated(skill.id), uiText(next.language).skillsTitle)
        }
      }
      if (command.action === "remove") {
        const removed = next.selectedSkills.filter((id) => id === command.name || id.endsWith(`/${command.name}`) || id.endsWith(`:${command.name}`))
        if (removed.length === 0) {
          write(uiText(next.language).noActiveSkillFound(command.name), uiText(next.language).skillsTitle)
        } else {
          next.selectedSkills = next.selectedSkills.filter((id) => !removed.includes(id))
          next.pendingSkillLoads = (next.pendingSkillLoads ?? []).filter((id) => !removed.includes(id))
          resetRunner = true
          write(uiText(next.language).skillRemoved(removed.join(", ")), uiText(next.language).skillsTitle)
        }
      }
      break
    }
  }

  return { settings: next, pendingImages, resetRunner, sessionAction, goalAction }
}

export async function sessionsText(store: SessionStore | undefined, currentSession: string | undefined, language: SessionSettings["language"]) {
  const copy = uiText(language)
  if (!store) return copy.noSessionStore
  const sessions = await store.list()
  if (sessions.length === 0) return copy.noSavedSessions
  return [
    copy.savedSessions,
    ...sessions.map((session, index) => copy.sessionSummary(index + 1, session.id, session.id === currentSession, session.messageCount)),
  ].join("\n")
}

export function settingsText(settings: SessionSettings, images: ImagePart[]) {
  return uiText(settings.language).settingsText({
    provider: settings.provider,
    model: settings.model,
    thinking: settings.thinking,
    effort: settings.effort,
    language: languageDisplay(settings.language),
    skills: settings.selectedSkills.join(", ") || "(none)",
    pendingSkillLoads: settings.pendingSkillLoads.join(", ") || "(none)",
    pendingImages: images.length,
    maxTokens: settings.maxTokens,
    maxSteps: settings.maxSteps,
  })
}

export function writeCliText(tui: TuiRenderer | undefined, text: string, title: string) {
  if (tui) {
    tui.panel(title, text)
    return
  }
  output.write(text.endsWith("\n") ? text : `${text}\n`)
}

export function collectRunInput(reader: LineReader, activeAbort: AbortController, queuedPrompts: { push: (text: string) => unknown }, tui?: TuiRenderer) {
  const pumpAbort = new AbortController()
  const copy = uiText(tui?.getLanguage() ?? "en")
  if (tui) tui.runInputHint()
  else output.write(`${copy.runInputHint}\n`)
  const done = (async () => {
    while (!pumpAbort.signal.aborted) {
      const line = await reader.nextLine("background", pumpAbort.signal)
      if (line === eofPrompt) break
      const text = line.trim()
      if (!text) continue
      if (isCancelInput(text)) {
        if (tui) tui.cancelling()
        else output.write(`${copy.cancellingRun}\n`)
        activeAbort.abort()
        pumpAbort.abort()
        break
      }
      queuedPrompts.push(text)
      if (tui) tui.queued(shortPrompt(text))
      else output.write(`${copy.queuedNextInput(shortPrompt(text))}\n`)
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
  return reader.question(tui?.inputPrompt() ?? uiText(tui?.getLanguage() ?? "en").inputPrompt)
}

export function permissionService(mode: AgentMode, reader: LineReader, cancelRun?: () => void, tui?: TuiRenderer) {
  const copy = uiText(tui?.getLanguage() ?? "en")
  return new PermissionService(defaultPermissionRules(mode), async (request) => {
    const basePrompt = permissionPrompt(request)
    const answer = (await questionWithPrompt(reader, tui?.permissionPrompt(request, basePrompt) ?? basePrompt)).trim().toLowerCase()
    tui?.resumeAfterPrompt()
    if (answer === eofPrompt) return "reject"
    if (isCancelInput(answer)) {
      cancelRun?.()
      if (tui) tui.cancelling()
      else output.write(`${copy.cancelledRun}\n`)
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
  return `Allow ${request.permission} for ${patterns}? [Y]es/[a]lways/[n]o`
}

async function questionWithPrompt(reader: LineReader, prompt: string) {
  output.write(`${prompt}\n`)
  return reader.question("permission> ")
}

export function promptToCommand(prompt: string) {
  return parseSlashCommand(prompt)
}
