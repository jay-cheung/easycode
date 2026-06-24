import { useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { DesktopDeleteSessionResult, DesktopFileSelection, DesktopGoalState, DesktopGoalStatusResult, DesktopListSessionsResult, DesktopListSkillsResult, DesktopLoadSessionResult, DesktopMessage, DesktopMessagePart, DesktopPermissionMode, DesktopPlanStatusResult, DesktopProviderListResult, DesktopProviderReadiness, DesktopProviderSetup, DesktopProviderSetupResult, DesktopRunMode, DesktopSessionSummary, DesktopSettings, DesktopSidecarStatus, DesktopSkillInfo, DesktopSlashCommandResult, DesktopWorkspaceStatus, SidecarFrame } from "../shared/protocol.js"
import { applyAttachmentAction, clearAttachmentSlashCommands, pickedFileSlashCommands, rejectedWorkspaceFileSummary, removeFileRefs, type AttachmentAction, type DesktopAttachment } from "./attachment-state.js"
import { permissionModeLabel, permissionPromptAfterRunDone, permissionRunSnapshot, permissionUiAfterRequest, sidecarPermissionReply, type PermissionReplyAction, type PermissionRunSnapshot } from "./permission-state.js"
import { canSubmitPlanDraft, goalAfterControlResult, goalAfterLifecycleEvent, goalFromControlResult, goalLifecycleSummary, planReplyPayload, planStatusAfterControlResult, planStatusFromResult, runStatusForGoalPhase, runStatusFromGoalControlResult, runStatusFromRunDone, shouldClearBlockingPromptsAfterRunDone, shouldReloadSessionAfterGoalControl, shouldReloadSessionAfterGoalLifecycle, shouldReloadSessionAfterPlanControl, shouldReloadSessionAfterRunDone, type PlanReplyAction } from "./plan-goal-state.js"
import { composerStateAfterQueuedInput, createQueuedRunInput, dequeueQueuedRunInput, isCancelRunInput, isRunProducingSlashInput, queuedInputLabel, shortQueuedPrompt, shouldDetachActiveRunForWorkspaceSwitch, shouldQueueRunInput, type QueuedRunInput } from "./run-queue.js"
import { draftSessionId as createDraftSessionId, draftSessionPromptPlan, mergeSessionListPreservingOrder, planWorkspaceRemoval, removeSessionPreview, sessionIdFromPrompt, sessionSwitchSlashCommand, titleFromPrompt, truncateSessionTitle, upsertSessionPreview as upsertSessionPreviewState, workspaceRemovalClearsDraft, workspaceRoots, workspaceSwitchPatch } from "./session-workspace-state.js"
import { canRunDesktopQuickSlashCommand, desktopQuickSlashCommands, type DesktopQuickSlashCommand } from "./slash-coverage.js"
import { effortSettingsCommand, languageSettingsCommand, maxStepsSettingsCommand, maxTokensSettingsCommand, modelSettingsCommand, providerSettingsCommand, thinkingSettingsCommand } from "./settings-commands.js"
import { applyDirectDesktopSettings, reconcileDesktopSettingsFromSidecar, restoreLoadedSessionSettings } from "./settings-sync.js"

type ChatItem =
  | { id: string; kind: "user"; text: string; time: string }
  | { id: string; kind: "assistant"; text: string; time: string }
  | { id: string; kind: "tool"; title: string; detail: string; status: "running" | "done"; open: boolean }
  | { id: string; kind: "status"; text: string }

type PermissionMode = DesktopPermissionMode
type PermissionPrompt = { requestId: string; title: string; detail: string }
type PlanPrompt = { runId: string; markdown: string }
type Attachment = DesktopAttachment
type RunStatus = "idle" | "running" | "waiting_plan" | "waiting_permission" | "done" | "failed" | "cancelled"
type Progress = { status: RunStatus; startedAt?: number; summary: string; provider?: string; model?: string; mode?: string; toolCalls: number; toolResults: number }
type RunMode = DesktopRunMode

export function App() {
  const [settings, setSettings] = useState<DesktopSettings>()
  const [items, setItems] = useState<ChatItem[]>([])
  const [prompt, setPrompt] = useState("")
  const [running, setRunning] = useState(false)
  const [queuedInputs, setQueuedInputs] = useState<QueuedRunInput[]>([])
  const [runMode, setRunMode] = useState<RunMode>("build")
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask")
  const [permission, setPermission] = useState<PermissionPrompt>()
  const [plan, setPlan] = useState<PlanPrompt>()
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>([])
  const [draftSession, setDraftSession] = useState(false)
  const [draftSessionId, setDraftSessionId] = useState<string>()
  const [draftSessionTitle, setDraftSessionTitle] = useState("")
  const [skills, setSkills] = useState<DesktopSkillInfo[]>([])
  const [goal, setGoal] = useState<DesktopGoalState>()
  const [planStatus, setPlanStatus] = useState<DesktopPlanStatusResult>()
  const [contextRailOpen, setContextRailOpen] = useState(false)
  const [providerSetupDismissed, setProviderSetupDismissed] = useState(false)
  const [workspaceStatus, setWorkspaceStatus] = useState<DesktopWorkspaceStatus>()
  const [providerOptions, setProviderOptions] = useState<string[]>([])
  const [providerReadiness, setProviderReadiness] = useState<DesktopProviderReadiness>()
  const [sidecarStatus, setSidecarStatus] = useState<DesktopSidecarStatus>()
  const [progress, setProgress] = useState<Progress>({ status: "idle", summary: "Ready for a local run.", toolCalls: 0, toolResults: 0 })
  const [now, setNow] = useState(Date.now())
  const streamRef = useRef<HTMLDivElement>(null)
  const skipNextStreamScrollRef = useRef(false)
  const progressRef = useRef<Progress>(progress)
  const settingsRef = useRef<DesktopSettings | undefined>(undefined)
  const runningRef = useRef(false)
  const draftSessionRef = useRef(false)
  const queuedInputsRef = useRef<QueuedRunInput[]>([])
  const activePermissionRef = useRef<PermissionRunSnapshot>(permissionRunSnapshot(runMode, permissionMode))

  useEffect(() => {
    void window.easycode.settings().then(setSettings)
    const off = window.easycode.onSidecarEvent(handleFrame)
    void window.easycode.initialize().then(async (result) => {
      const initialized = result as { root?: string; session?: string; settings?: DesktopSettings }
      if (initialized.settings) {
        const next = await window.easycode.updateSettings({
          ...initialized.settings,
          ...(initialized.root ? { workspaceRoot: initialized.root } : {}),
          ...(initialized.session ? { session: initialized.session } : {}),
        })
        setSettings(next)
      }
      await refreshAll(initialized.session)
    }).catch(async (error) => {
      reportUiError(error, "Sidecar initialize failed.")
      await refreshSidecarStatus().catch(() => undefined)
    })
    return off
  }, [])

  useEffect(() => {
    if (skipNextStreamScrollRef.current) {
      skipNextStreamScrollRef.current = false
      return
    }
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" })
  }, [items, progress])

  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    runningRef.current = running
  }, [running])

  useEffect(() => {
    draftSessionRef.current = draftSession
  }, [draftSession])

  useEffect(() => {
    queuedInputsRef.current = queuedInputs
  }, [queuedInputs])

  useEffect(() => {
    if (!progress.startedAt || !running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [progress.startedAt, running])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.key.toLowerCase() === "n") {
        event.preventDefault()
        void newSession()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [running, settings?.session])

  const workspaceName = useMemo(() => {
    const root = settings?.workspaceRoot || "easycode"
    return workspaceDisplayName(root)
  }, [settings?.workspaceRoot])
  const visibleWorkspaceRoots = workspaceRoots(settings?.workspaceRoot, settings?.recentWorkspaces)
  const currentSession = sessions.find((session) => session.id === settings?.session)
  const activeSessionTitle = draftSession ? "New Chat" : currentSession ? sessionTitle(currentSession) : draftSessionTitle || settings?.session || "Add desktop sidecar client"
  const providerSetupVisible = Boolean(settings && providerReadiness && providerReadiness.status !== "ready" && !providerSetupDismissed)
  const canStartProviderRun = !providerReadiness || providerReadiness.status === "ready"

  const handleFrame = (frame: SidecarFrame) => {
    if (!("type" in frame) || frame.type !== "event") return
    const event = frame.event
    if (event.type === "run_start") {
      updateProgress({ status: "running", startedAt: progressRef.current.startedAt ?? Date.now(), summary: `${event.provider}${event.model ? ` ${event.model}` : ""} started.`, provider: event.provider, model: event.model, mode: event.mode, toolCalls: 0, toolResults: 0 })
    } else if (event.type === "provider_progress") {
      updateProgress({ ...progressRef.current, status: "running", summary: `${event.provider}${event.model ? ` ${event.model}` : ""} ${event.phase ?? "working"}.` })
    } else if (event.type === "goal") {
      setGoal((current) => goalAfterLifecycleEvent(current, event))
      updateProgress({ ...progressRef.current, status: runStatusForGoalPhase(event.phase), startedAt: progressRef.current.startedAt ?? Date.now(), mode: "goal", summary: goalLifecycleSummary(event) })
      if (shouldReloadSessionAfterGoalLifecycle(event.phase)) {
        void syncCurrentSessionMessages().catch((error) => reportUiError(error, "Goal session sync failed."))
        void refreshGoalStatus()
        void refreshPlanStatus()
        void refreshSessions()
      }
    } else if (event.type === "text_delta") appendAssistant(event.text)
    else if (event.type === "tool_call") {
      updateProgress({ ...progressRef.current, status: "running", startedAt: progressRef.current.startedAt ?? Date.now(), summary: `Running ${event.call.name}.`, toolCalls: progressRef.current.toolCalls + 1 })
      appendTool(event.call.name, JSON.stringify(event.call.input, null, 2), "running")
    } else if (event.type === "tool_result") {
      updateProgress({ ...progressRef.current, status: "running", startedAt: progressRef.current.startedAt ?? Date.now(), summary: `${event.title || event.toolName} completed.`, toolResults: progressRef.current.toolResults + 1 })
      appendTool(event.title || event.toolName, event.output, "done")
    } else if (event.type === "permission_request") {
      const nextPermission = permissionUiAfterRequest(activePermissionRef.current.effectiveMode, event.request)
      if (nextPermission.prompt) {
        updateProgress({ ...progressRef.current, status: nextPermission.progressStatus, summary: nextPermission.progressSummary })
        setPermission(nextPermission.prompt)
      } else {
        appendStatus(nextPermission.statusText)
        void window.easycode.replyPermission(event.request.id, nextPermission.autoReply).catch((error) => reportUiError(error, "Permission auto-reply failed."))
      }
    } else if (event.type === "plan_approval_request") {
      updateProgress({ ...progressRef.current, status: "waiting_plan", startedAt: progressRef.current.startedAt ?? Date.now(), summary: "Plan is waiting for approval." })
      setPlan({ runId: frame.runId!, markdown: event.markdown })
    } else if (event.type === "provider_metrics") {
      updateProgress({ ...progressRef.current, status: "running", startedAt: progressRef.current.startedAt ?? Date.now(), summary: `${event.metrics.provider} metrics received.`, provider: event.metrics.provider, model: event.metrics.model })
    } else if (event.type === "failure") {
      updateProgress({ ...progressRef.current, status: "failed", summary: event.text })
    } else if (event.type === "run_done") {
      setRunning(false)
      runningRef.current = false
      if (shouldClearBlockingPromptsAfterRunDone(event.status)) {
        setPermission((current) => permissionPromptAfterRunDone(current, event.status))
        setPlan(undefined)
      }
      updateProgress({ ...progressRef.current, status: runStatusFromRunDone(event.status), startedAt: progressRef.current.startedAt, summary: `Run ${event.status}.` })
      if (shouldReloadSessionAfterRunDone(event.status)) void syncCurrentSessionMessages().catch((error) => reportUiError(error, "Session message sync failed."))
      void refreshWorkspaceStatus()
      void refreshSessions()
      void refreshGoalStatus()
      void refreshPlanStatus()
      void refreshProviderReadiness()
      void refreshSidecarStatus()
      window.setTimeout(() => flushQueuedInput(), 0)
    } else if (event.type === "fatal") {
      setRunning(false)
      runningRef.current = false
      reportUiError(event.message)
      void refreshSidecarStatus()
    } else if (event.type === "session_changed") {
      void syncSidecarSession(event.session).catch((error) => reportUiError(error, "Session sync failed."))
    }
  }

  const sendPrompt = async () => {
    await submitInput(prompt)
  }

  const submitInput = async (input: string, source: "composer" | "queue" = "composer", queuedRunInput?: QueuedRunInput) => {
    let text = input.trim()
    if (!text) return
    if (shouldQueueRunInput(text, runningRef.current)) {
      enqueueQueuedInput(text)
      if (source === "composer") {
        const cleared = composerStateAfterQueuedInput({ prompt, attachments })
        setPrompt(cleared.prompt)
        setAttachments(cleared.attachments)
      }
      return
    }
    if (runningRef.current && isCancelRunInput(text)) {
      if (source === "composer") setPrompt("")
      await cancelRun()
      return
    }
    if (text.startsWith("/")) {
      try {
        const slash = await window.easycode.executeSlashCommand(text, queuedRunInput?.images.length ?? pendingImageCount(), queuedRunInput?.files.length ?? pendingFileCount()) as DesktopSlashCommandResult
        if (slash.handled) {
          if (source === "composer") setPrompt("")
          await applySlashResult(text, slash)
          if (source === "queue") window.setTimeout(() => flushQueuedInput(), 0)
          return
        }
        text = slash.promptText
        await runPromptText(text, slash.mode, queuedRunInput)
        return
      } catch (error) {
        appendStatus(error instanceof Error ? error.message : String(error))
        updateProgress({ ...progressRef.current, status: "failed", summary: error instanceof Error ? error.message : String(error) })
        if (source === "queue") window.setTimeout(() => flushQueuedInput(), 0)
        return
      }
    }
    await runPromptText(text, source === "queue" ? queuedRunInput?.mode ?? "build" : undefined, queuedRunInput)
  }

  const runPromptText = async (text: string, modeOverride?: RunMode, queuedRunInput?: QueuedRunInput) => {
    if (!ensureProviderReady()) return
    const images = queuedRunInput?.images ?? attachments.filter((file) => file.kind === "image").map((file) => file.path)
    const files = queuedRunInput?.files ?? attachments.filter((file) => file.kind === "file").map((file) => file.path)
    try {
      await prepareSessionForPrompt(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendStatus(message)
      updateProgress({ ...progressRef.current, status: "failed", summary: message })
      return
    }
    setPrompt("")
    setAttachments([])
    setRunning(true)
    runningRef.current = true
    updateProgress({ status: "running", startedAt: Date.now(), summary: "Preparing run context.", toolCalls: 0, toolResults: 0 })
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "user", text, time: currentTime() }, { id: crypto.randomUUID(), kind: "assistant", text: "", time: currentTime() }])
    try {
      const effectiveRunMode = modeOverride ?? runMode
      const permissionSnapshot = permissionRunSnapshot(effectiveRunMode, queuedRunInput?.permissionMode ?? permissionMode)
      activePermissionRef.current = permissionSnapshot
      await window.easycode.runPrompt(text, effectiveRunMode, images, permissionSnapshot.sidecarMode, files)
    } catch (error) {
      appendStatus(error instanceof Error ? error.message : String(error))
      setRunning(false)
      runningRef.current = false
      updateProgress({ ...progressRef.current, status: "failed", summary: error instanceof Error ? error.message : String(error) })
      window.setTimeout(() => flushQueuedInput(), 0)
    }
  }

  const cancelRun = async () => {
    if (!running) return
    updateProgress({ ...progressRef.current, status: "cancelled", summary: "Cancelling run..." })
    try {
      const result = await window.easycode.cancelRun() as { cancelled?: boolean }
      if (!result.cancelled) updateProgress({ ...progressRef.current, status: "idle", summary: "No active run to cancel." })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendStatus(message)
      updateProgress({ ...progressRef.current, status: "failed", summary: message })
    }
  }

  const pendingImageCount = () => attachments.filter((file) => file.kind === "image").length
  const pendingFileCount = () => attachments.filter((file) => file.kind === "file").length

  const applySlashResult = async (commandText: string, result: Extract<DesktopSlashCommandResult, { handled: true }>) => {
    setItems((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: "user", text: commandText, time: currentTime() },
      { id: crypto.randomUUID(), kind: "status", text: `${result.title}\n${result.text}` },
    ])
    const action = result.action
    if (isAttachmentAction(action)) {
      setAttachments((current) => applyAttachmentAction(current, action, crypto.randomUUID()))
    } else if (action?.type === "resumeGoal") {
      await resumeGoal()
      return
    }
    if (result.session) {
      await selectSession(result.session)
      return
    }
    if (result.settings) {
      const next = await reconcileDesktopSettingsFromSidecar(window.easycode, result.settings)
      setSettings(next)
    }
    await refreshAll()
    updateProgress({ ...progressRef.current, status: "idle", summary: result.title, toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
  }

  const applySettingsCommand = async (commandText: string, fallback?: Partial<DesktopSettings>) => {
    try {
      const result = await window.easycode.executeSlashCommand(commandText, pendingImageCount(), pendingFileCount()) as DesktopSlashCommandResult
      if (!result.handled) {
        if (fallback) await updateSettings(fallback)
        return
      }
      appendStatus(`${result.title}\n${result.text}`)
      if (result.settings) {
        const next = await reconcileDesktopSettingsFromSidecar(window.easycode, result.settings)
        setSettings(next)
      }
      await refreshAll()
      updateProgress({ ...progressRef.current, status: "idle", summary: result.title, toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
    } catch (error) {
      reportUiError(error)
    }
  }

  const runLocalSlashCommand = async (command: DesktopQuickSlashCommand) => {
    if (!canRunDesktopQuickSlashCommand(command, running)) return
    try {
      const result = await window.easycode.executeSlashCommand(command.command, pendingImageCount(), pendingFileCount()) as DesktopSlashCommandResult
      if (result.handled) await applySlashResult(command.command, result)
      else setPrompt(command.command)
    } catch (error) {
      reportUiError(error, "Command failed.")
    }
  }

  const updateSettings = async (patch: Partial<DesktopSettings>) => {
    try {
      const next = await applyDirectDesktopSettings(window.easycode, patch)
      setSettings(next)
      await refreshAll()
    } catch (error) {
      reportUiError(error, "Settings update failed.")
      await refreshSidecarStatus()
    }
  }

  const configureProvider = async (input: DesktopProviderSetup) => {
    const result = await window.easycode.configureProvider(input) as DesktopProviderSetupResult
    setSettings(result.settings)
    await window.easycode.initialize()
    const readiness = await window.easycode.getProviderReadiness() as DesktopProviderReadiness
    setProviderReadiness(readiness)
    await refreshAll(result.settings.session)
    if (readiness.status !== "ready") {
      throw new Error(`Provider configuration saved locally in ${result.envPath}, but EasyCode is still not ready. ${providerReadinessError(readiness)}`)
    }
    appendStatus(`Provider configuration saved locally in ${result.envPath}.`)
    return result
  }

  const ensureProviderReady = () => {
    if (!providerReadiness || providerReadiness.status === "ready") return true
    const text = `Provider is not ready. ${providerReadinessError(providerReadiness)}`
    setProviderSetupDismissed(false)
    setContextRailOpen(true)
    appendStatus(text)
    updateProgress({ ...progressRef.current, status: "failed", summary: text })
    return false
  }

  const refreshAll = async (session = settings?.session) => {
    const steps: Array<[string, () => Promise<void>]> = [
      ["providers", refreshProviders],
      ["provider readiness", refreshProviderReadiness],
      ["skills", refreshSkills],
      ["sessions", refreshSessions],
      ["goal", () => refreshGoalStatus(session)],
      ["plan", () => refreshPlanStatus(session)],
      ["workspace", refreshWorkspaceStatus],
      ["sidecar", refreshSidecarStatus],
    ]
    const results = await Promise.allSettled(steps.map(([, step]) => step()))
    const failures = results.flatMap((result, index) => result.status === "rejected" ? [`${steps[index][0]}: ${errorMessage(result.reason)}`] : [])
    if (failures.length > 0) {
      const text = `Refresh incomplete. ${failures.join("; ")}`
      appendStatus(text)
      updateProgress({ ...progressRef.current, status: "failed", summary: text })
    }
  }

  const refreshProviders = async () => {
    const result = await window.easycode.listProviders() as DesktopProviderListResult
    setProviderOptions(result.providers.filter((provider) => provider !== "fake" && provider !== "simulated"))
  }

  const refreshProviderReadiness = async () => {
    setProviderReadiness(await window.easycode.getProviderReadiness())
  }

  const refreshSkills = async () => {
    const result = await window.easycode.listSkills() as DesktopListSkillsResult
    setSkills(result.skills)
    setSettings((current) => current ? {
      ...current,
      selectedSkills: result.selectedSkills,
      pendingSkillLoads: result.pendingSkillLoads,
    } : current)
  }

  const refreshSessions = async () => {
    const result = await window.easycode.listSessions() as DesktopListSessionsResult
    setSessions((current) => mergeSessionListPreservingOrder(current, result.sessions))
    await syncSidecarSession(result.currentSession)
  }

  const refreshGoalStatus = async (session = settings?.session) => {
    const result = await window.easycode.getGoalStatus(session) as DesktopGoalStatusResult
    setGoal(result.goal)
  }

  const refreshPlanStatus = async (session = settings?.session) => {
    const result = await window.easycode.getPlanStatus(session) as DesktopPlanStatusResult
    setPlanStatus(planStatusFromResult(result))
  }

  const refreshWorkspaceStatus = async () => {
    setWorkspaceStatus(await window.easycode.workspaceStatus())
  }

  const refreshSidecarStatus = async () => {
    setSidecarStatus(await window.easycode.sidecarStatus())
  }

  const selectSession = async (session: string) => {
    if (running) return
    if (draftSession && session === draftSessionId) return
    try {
      const switched = await window.easycode.executeSlashCommand(sessionSwitchSlashCommand(session), pendingImageCount(), pendingFileCount()) as DesktopSlashCommandResult
      if (!switched.handled) throw new Error(`Session switch was not handled: ${session}`)
      await loadSessionIntoUi(switched.session ?? session, `Loaded session ${switched.session ?? session}.`)
    } catch (error) {
      reportUiError(error, "Session load failed.")
      await refreshSessions()
    }
  }

  const toggleToolRow = (id: string) => {
    skipNextStreamScrollRef.current = true
    setItems((current) => current.map((row) => row.id === id && row.kind === "tool" ? { ...row, open: !row.open } : row))
  }

  const loadSessionIntoUi = async (session: string, summary: string) => {
    const loaded = await window.easycode.loadSession(session) as DesktopLoadSessionResult
    setDraftSession(false)
    setDraftSessionId(undefined)
    setDraftSessionTitle("")
    const restored = await restoreLoadedSessionSettings(window.easycode, session, loaded.settings)
    setSettings(restored)
    setItems(messagesToItems(loaded.messages))
    updateProgress({ status: "idle", summary, toolCalls: 0, toolResults: 0 })
    await refreshAll(session)
  }

  const syncSidecarSession = async (session: string) => {
    const current = settingsRef.current
    if (!current || current.session === session) return
    const loaded = await window.easycode.loadSession(session) as DesktopLoadSessionResult
    const next = await window.easycode.updateSettings({ ...loaded.settings, session })
    setSettings(next)
    setDraftSession(false)
    setDraftSessionId(undefined)
    setDraftSessionTitle("")
    if (!runningRef.current && !draftSessionRef.current) {
      setItems(messagesToItems(loaded.messages))
      updateProgress({ status: "idle", summary: `Loaded session ${session}.`, toolCalls: 0, toolResults: 0 })
    }
  }

  const syncCurrentSessionMessages = async (session = settingsRef.current?.session) => {
    if (!session) return
    const loaded = await window.easycode.loadSession(session) as DesktopLoadSessionResult
    setItems(messagesToItems(loaded.messages))
  }

  const newSession = async () => {
    if (running) return
    const session = createDraftSessionId()
    try {
      const switched = await window.easycode.executeSlashCommand(sessionSwitchSlashCommand(session), 0, 0) as DesktopSlashCommandResult
      if (!switched.handled) throw new Error(`Session create was not handled: ${session}`)
      const createdSession = switched.session ?? session
      const loaded = await window.easycode.loadSession(createdSession) as DesktopLoadSessionResult
      const restored = await restoreLoadedSessionSettings(window.easycode, createdSession, loaded.settings)
      setSettings(restored)
      settingsRef.current = restored
      setDraftSession(true)
      draftSessionRef.current = true
      setDraftSessionId(createdSession)
      setDraftSessionTitle("")
      setSessions((current) => upsertSessionPreviewState(draftSessionId ? removeSessionPreview(current, draftSessionId) : current, createdSession, "New Chat"))
      setItems([])
      setAttachments([])
      updateProgress({ status: "idle", summary: "New chat ready.", toolCalls: 0, toolResults: 0 })
      await refreshSessions()
    } catch (error) {
      reportUiError(error, "Session create failed.")
      await refreshSessions()
    }
  }

  const deleteSession = async (session: string) => {
    if (running) return
    if (draftSession && session === draftSessionId) {
      setSessions((current) => removeSessionPreview(current, session))
      setDraftSession(false)
      setDraftSessionId(undefined)
      setDraftSessionTitle("")
      setItems([])
      updateProgress({ status: "idle", summary: "Draft session removed.", toolCalls: 0, toolResults: 0 })
      return
    }
    try {
      const result = await window.easycode.deleteSession(session) as DesktopDeleteSessionResult
      if (session === settings?.session) {
        if (result.currentSession) await selectSession(result.currentSession)
        else await newSession()
        return
      }
      await refreshSessions()
      updateProgress({ ...progressRef.current, status: "idle", summary: `Deleted session ${session}.` })
    } catch (error) {
      reportUiError(error, "Session delete failed.")
    }
  }

  const selectWorkspace = async (workspaceRoot: string) => {
    if (workspaceRoot === settings?.workspaceRoot) return
    try {
      const patch = workspaceSwitchPatch(workspaceRoot)
      if (shouldDetachActiveRunForWorkspaceSwitch(settings?.workspaceRoot, workspaceRoot, runningRef.current)) {
        setRunning(false)
        runningRef.current = false
        setQueuedInputs([])
      }
      setDraftSession(false)
      setDraftSessionId(undefined)
      setDraftSessionTitle("")
      const next = await window.easycode.updateSettings(patch)
      setSettings(next)
      await window.easycode.initialize()
      setAttachments([])
      await loadSessionIntoUi(patch.session, `Opened workspace ${workspaceRoot}.`)
    } catch (error) {
      reportUiError(error, "Workspace open failed.")
      await refreshSidecarStatus()
    }
  }

  const addWorkspace = async () => {
    try {
      const workspaceRoot = await window.easycode.pickWorkspace()
      if (!workspaceRoot) return
      await selectWorkspace(workspaceRoot)
    } catch (error) {
      reportUiError(error, "Workspace picker failed.")
    }
  }

  const removeWorkspace = async (workspaceRoot?: string) => {
    const targetWorkspace = workspaceRoot ?? settings?.workspaceRoot
    if (running || !settings || !targetWorkspace) return
    try {
      const plan = planWorkspaceRemoval(settings.workspaceRoot, settings.recentWorkspaces, targetWorkspace)
      if (plan.type === "keep_last") return
      if (plan.type === "remove_inactive") {
        const next = await window.easycode.updateSettings({ recentWorkspaces: plan.recentWorkspaces })
        setSettings(next)
        await window.easycode.removeWorkspaceSidecar(targetWorkspace)
        updateProgress({ ...progressRef.current, status: "idle", summary: `Removed workspace ${targetWorkspace}.` })
        return
      }
      if (workspaceRemovalClearsDraft(plan)) {
        setDraftSession(false)
        setDraftSessionId(undefined)
        setDraftSessionTitle("")
      }
      const next = await window.easycode.updateSettings({ workspaceRoot: plan.workspaceRoot, recentWorkspaces: plan.recentWorkspaces, session: plan.session })
      setSettings(next)
      await window.easycode.initialize()
      setAttachments([])
      await loadSessionIntoUi(plan.session, `Removed workspace and opened ${plan.workspaceRoot}.`)
      await window.easycode.removeWorkspaceSidecar(targetWorkspace)
    } catch (error) {
      reportUiError(error, "Workspace remove failed.")
      await refreshSidecarStatus()
    }
  }

  const runWorkspaceAction = async (action: () => Promise<unknown> | unknown) => {
    try {
      await action()
    } catch (error) {
      reportUiError(error, "Workspace action failed.")
    }
  }

  const pickFiles = async () => {
    if (running) return
    try {
      const files = await window.easycode.pickFiles() as DesktopFileSelection[]
      if (files.length === 0) return
      const planned = pickedFileSlashCommands(files)
      if (planned.rejectedCount > 0) {
        const text = rejectedWorkspaceFileSummary(planned.rejectedCount)
        appendStatus(text)
        updateProgress({ ...progressRef.current, status: "idle", summary: text })
      }
      for (const command of planned.commands) {
        const result = await window.easycode.executeSlashCommand(command, pendingImageCount(), pendingFileCount()) as DesktopSlashCommandResult
        if (result.handled) applyAttachmentSlashResult(result)
      }
    } catch (error) {
      reportUiError(error, "File picker failed.")
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((file) => file.id === id)
      if (removed?.kind === "file") setPrompt((text) => removeFileRefs(text, [removed.path]))
      return current.filter((file) => file.id !== id)
    })
  }

  const applyAttachmentSlashResult = (result: Extract<DesktopSlashCommandResult, { handled: true }>) => {
    appendStatus(`${result.title}\n${result.text}`)
    const action = result.action
    if (isAttachmentAction(action)) setAttachments((current) => applyAttachmentAction(current, action, crypto.randomUUID()))
    updateProgress({ ...progressRef.current, status: "idle", summary: result.title })
  }

  const clearAttachments = async () => {
    if (running) return
    const commands = clearAttachmentSlashCommands(attachments)
    if (commands.length === 0) return
    const filePaths = attachments.filter((file) => file.kind === "file").map((file) => file.path)
    try {
      for (const command of commands) {
        const result = await window.easycode.executeSlashCommand(command, pendingImageCount(), pendingFileCount()) as DesktopSlashCommandResult
        if (result.handled) applyAttachmentSlashResult(result)
      }
      if (filePaths.length > 0) setPrompt((text) => removeFileRefs(text, filePaths))
    } catch (error) {
      reportUiError(error, "Attachment clear failed.")
    }
  }

  const toggleSkill = async (skill: DesktopSkillInfo) => {
    if (running || !settings) return
    const selected = new Set(settings.selectedSkills ?? [])
    const activeById = selected.has(skill.id)
    const activeByName = selected.has(skill.name)
    const target = activeById ? skill.id : activeByName ? skill.name : skill.id
    await applySettingsCommand(activeById || activeByName ? `/skill remove ${target}` : `/skill use ${skill.id}`)
  }

  const clearSkills = async () => {
    if (running || !settings) return
    await applySettingsCommand("/skill clear")
  }

  const clearGoal = async () => {
    if (running) return
    try {
      const result = await window.easycode.clearGoal(settings?.session) as { cleared?: boolean; text?: string }
      setGoal((current) => goalAfterControlResult(current, result))
      if (shouldReloadSessionAfterGoalControl(result)) await syncCurrentSessionMessages()
      await refreshGoalStatus()
      updateProgress({ ...progressRef.current, status: "idle", summary: result.text ?? (result.cleared ? "Goal cleared." : "No active goal."), toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
    } catch (error) {
      reportUiError(error, "Goal clear failed.")
    }
  }

  const pauseGoal = async () => {
    if (running) return
    try {
      const result = await window.easycode.pauseGoal(settings?.session) as { goal?: DesktopGoalState; text?: string }
      setGoal(goalFromControlResult(result))
      if (shouldReloadSessionAfterGoalControl(result)) await syncCurrentSessionMessages()
      await refreshGoalStatus()
      updateProgress({ ...progressRef.current, status: "idle", summary: result.text ?? "Goal paused.", toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
    } catch (error) {
      reportUiError(error, "Goal pause failed.")
    }
  }

  const resumeGoal = async () => {
    if (running) return
    setRunning(true)
    runningRef.current = true
    updateProgress({ status: "running", startedAt: Date.now(), summary: "Resuming goal.", mode: "goal", toolCalls: 0, toolResults: 0 })
    try {
      const result = await window.easycode.resumeGoal(settings?.session) as { status?: string; text?: string }
      setRunning(false)
      runningRef.current = false
      updateProgress({ ...progressRef.current, status: runStatusFromGoalControlResult(result, progressRef.current.status), summary: result.text ?? "Goal resume finished." })
      if (shouldReloadSessionAfterGoalControl(result)) await syncCurrentSessionMessages()
      await refreshGoalStatus()
      await refreshPlanStatus()
      await refreshWorkspaceStatus()
      await refreshSessions()
      window.setTimeout(() => flushQueuedInput(), 0)
    } catch (error) {
      appendStatus(error instanceof Error ? error.message : String(error))
      setRunning(false)
      runningRef.current = false
      updateProgress({ ...progressRef.current, status: "failed", summary: error instanceof Error ? error.message : String(error) })
      window.setTimeout(() => flushQueuedInput(), 0)
    }
  }

  const clearPlan = async () => {
    if (running) return
    try {
      const result = await window.easycode.clearPlan(settings?.session) as { cleared?: boolean; text?: string }
      setPlanStatus((current) => planStatusAfterControlResult(current, result))
      if (shouldReloadSessionAfterPlanControl(result)) await syncCurrentSessionMessages()
      await refreshPlanStatus()
      updateProgress({ ...progressRef.current, status: "idle", summary: result.text ?? (result.cleared ? "Plan cleared." : "No active plan."), toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
    } catch (error) {
      reportUiError(error, "Plan clear failed.")
    }
  }

  const prepareSessionForPrompt = async (text: string) => {
    if (!draftSession) return
    const { session, title } = draftSessionPromptPlan(text, draftSessionId)
    const next = await window.easycode.updateSettings({ session })
    setSettings(next)
    settingsRef.current = next
    setDraftSession(false)
    draftSessionRef.current = false
    setDraftSessionId(undefined)
    setDraftSessionTitle(title)
    await window.easycode.initialize()
    await refreshSessions()
    upsertSessionPreview(session, title)
  }

  return (
    <main className={`shell ${contextRailOpen ? "" : "rail-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand-row"><div className="brand-mark">EC</div><strong>EasyCode</strong></div>
        <SidebarGroup title="Workspaces" action="+" onAction={addWorkspace}>
          <div className="workspace-list">
            {visibleWorkspaceRoots.map((root) => {
              const active = root === settings?.workspaceRoot
              return <div className={`workspace-card ${active ? "active" : ""}`} key={root}>
                <div className="workspace-head">
                  <button className="workspace-select" onClick={() => selectWorkspace(root)} disabled={active} title={root}>
                    <span className="folder-icon" />
                    <span className="workspace-title"><strong>{workspaceDisplayName(root)}</strong><small>{root}</small></span>
                  </button>
                  <button className="icon-button add-session-button" onClick={newSession} disabled={running || !active} aria-label={`New session in ${workspaceDisplayName(root)}`}>+</button>
                  <div className="workspace-menu-host">
                    <button className="icon-button workspace-more" aria-label={`${workspaceDisplayName(root)} menu`}><span>...</span></button>
                    <div className="workspace-menu">
                      <button onClick={() => void runWorkspaceAction(() => window.easycode.showWorkspace(root))}>Show in Finder</button>
                      <button onClick={() => void runWorkspaceAction(() => removeWorkspace(root))} disabled={running || visibleWorkspaceRoots.length <= 1} className="danger">Remove Workspace</button>
                    </div>
                  </div>
                </div>
                {active && <div className="workspace-status-line">
                  <span className={workspaceStatus?.clean ? "ok" : "warn"}>{workspaceStatus?.clean ? "Clean" : `${workspaceStatus?.changedFiles ?? 0} changed`}</span>
                  <span>{workspaceStatus?.branch ?? "unknown"}</span>
                </div>}
                {active && <div className="workspace-session-list">
                  {sessions.length === 0 && <div className="empty-list">No saved sessions</div>}
                  {sessions.map((session) => <div className={`thread-row ${(draftSession && session.id === draftSessionId) || (!draftSession && session.id === settings?.session) ? "active" : ""}`} key={session.id}>
                    <button className="thread-select" onClick={() => selectSession(session.id)} disabled={running} title={session.title || session.id}>
                      <span>{sessionTitle(session)}</span>
                      <time>{relativeTime(session.updatedAt)}</time>
                    </button>
                    <button className="session-delete" onClick={() => deleteSession(session.id)} disabled={running} aria-label={`Delete ${sessionTitle(session)}`}>×</button>
                  </div>)}
                </div>}
              </div>
            })}
          </div>
        </SidebarGroup>
        <div className="sidebar-footer">
          <div><span className="status-dot green" />Local only</div>
        </div>
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div>
            <h1>{activeSessionTitle}</h1>
            <div className="chips"><span>{workspaceStatus?.branch ?? "unknown"}</span><span className={workspaceStatus?.clean ? "success" : "warn"}>{workspaceStatus?.clean ? "Clean" : `${workspaceStatus?.changedFiles ?? 0} changed`}</span><span>Local</span></div>
          </div>
          <div className="top-actions">
            <button className="ghost" onClick={() => { void refreshAll() }}>Refresh</button>
            <button className="ghost" onClick={() => { void cancelRun() }} disabled={!running}>Cancel</button>
          </div>
        </header>

        <div className="stream" ref={streamRef}>
          <ProgressCard progress={progress} running={running} />
          {items.length === 0 && <EmptyState />}
          {items.map((item) => item.kind === "tool" ? <ToolRow key={item.id} item={item} onToggle={toggleToolRow} /> : <Message key={item.id} item={item} />)}
        </div>

        <Composer
          attachments={attachments}
          onClearAttachments={clearAttachments}
          onPickFiles={pickFiles}
          onRemoveAttachment={removeAttachment}
          permissionMode={permissionMode}
          prompt={prompt}
          providerReady={canStartProviderRun}
          providerReadiness={providerReadiness}
          runMode={runMode}
          running={running}
          setPermissionMode={setPermissionMode}
          setPrompt={setPrompt}
          setRunMode={setRunMode}
          sendPrompt={sendPrompt}
          queuedCount={queuedInputs.length}
        />
      </section>

      <aside className={`context-rail ${contextRailOpen ? "open" : "collapsed"}`}>
        {!contextRailOpen && <button className="rail-expand" onClick={() => setContextRailOpen(true)} aria-label="Show settings">
          <span>Settings</span>
          <span className={`status-dot ${sidecarStatus?.running ? "green" : "red"}`} />
        </button>}
        {contextRailOpen && <>
          <div className="rail-header"><strong>Settings</strong><button onClick={() => setContextRailOpen(false)}>Hide</button></div>
          <Panel title="Environment">
            <InfoRow label="Workspace" value={workspaceName} detail={settings?.workspaceRoot || "Not selected"} status="ok" />
            <EditableRow label="Sidecar" value={settings?.sidecarPath ?? ""} placeholder={sidecarStatus?.path ?? "Bundled or PATH easycode"} onCommit={(value) => updateSettings({ sidecarPath: value.trim() || undefined })} />
            <InfoRow label="Sidecar Status" value={sidecarStatusLabel(sidecarStatus)} detail={sidecarStatusDetail(sidecarStatus)} status={sidecarStatusTone(sidecarStatus)} />
            <SelectRow label="Provider" value={settings?.provider ?? "deepseek"} options={providerOptions} onChange={(provider) => applySettingsCommand(providerSettingsCommand(provider))} />
            <InfoRow label="Provider Status" value={providerReadinessLabel(providerReadiness)} detail={providerReadinessDetail(providerReadiness)} status={providerReadiness?.status === "ready" ? "ok" : "warn"} />
            <EditableRow label="Model" value={settings?.model ?? ""} placeholder="Provider default" onCommit={(model) => {
              return applySettingsCommand(modelSettingsCommand(model))
            }} />
            <ToggleRow label="Thinking" value={settings?.thinking ?? true} onChange={(thinking) => applySettingsCommand(thinkingSettingsCommand(thinking))} />
            <SelectRow label="Effort" value={settings?.effort ?? "high"} options={["low", "medium", "high", "max"]} onChange={(effort) => applySettingsCommand(effortSettingsCommand(effort))} />
            <SelectRow label="Language" value={settings?.language ?? "en"} options={["en", "zh", "ja", "fr", "ko", "de"]} onChange={(language) => applySettingsCommand(languageSettingsCommand(language))} />
            <InfoRow label="Git Branch" value={workspaceStatus?.branch ?? "unknown"} detail={aheadBehind(workspaceStatus)} />
            <InfoRow label="Working Tree" value={workspaceStatus?.clean ? "Clean" : "Modified"} status={workspaceStatus?.clean ? "ok" : "warn"} />
            <InfoRow label="Changes" value={`+${workspaceStatus?.added ?? 0} -${workspaceStatus?.deleted ?? 0}`} status={workspaceStatus?.clean ? "ok" : "warn"} />
          </Panel>
          <CommandPanel commands={desktopQuickSlashCommands} running={running} onRun={runLocalSlashCommand} />
          <Panel title="Run">
            <InfoRow label="Duration" value={progress.startedAt ? elapsed(progress.startedAt, now) : "0m"} />
            <InfoRow label="Permission" value={permissionModeLabel(permissionRunSnapshot(runMode, permissionMode).effectiveMode)} />
            <NumberRow label="Max Tokens" value={settings?.maxTokens} fallback={32000} onCommit={(maxTokens) => applySettingsCommand(maxTokensSettingsCommand(maxTokens))} />
            <NumberRow label="Max Steps" value={settings?.maxSteps} fallback={66} onCommit={(maxSteps) => applySettingsCommand(maxStepsSettingsCommand(maxSteps))} />
            <InfoRow label="Run State" value={displayRunStatus(progress.status)} status={running ? "warn" : progress.status === "done" ? "ok" : progress.status === "failed" ? "warn" : undefined} />
          </Panel>
          <PlanPanel planStatus={planStatus} running={running} onClear={clearPlan} />
          <GoalPanel goal={goal} running={running} onClear={clearGoal} onPause={pauseGoal} onResume={resumeGoal} />
          <Panel title="Prompt Context">
            <InfoRow label="workspace" value={workspaceName} detail="Local repository" />
            <InfoRow label="attached images" value={String(attachments.filter((file) => file.kind === "image").length)} />
            <InfoRow label="referenced files" value={String(attachments.filter((file) => file.kind === "file").length)} />
          </Panel>
          <SkillsPanel skills={skills} selected={settings?.selectedSkills ?? []} running={running} onClear={clearSkills} onToggle={toggleSkill} />
          <div className="rail-footer"><span className={`status-dot ${sidecarStatusDot(sidecarStatus)}`} />Sidecar <span>{sidecarStatusLabel(sidecarStatus)}</span></div>
        </>}
      </aside>

      {permission && <PermissionModal prompt={permission} onClose={() => setPermission(undefined)} onError={reportUiError} />}
      {plan && <PlanModal prompt={plan} onClose={() => setPlan(undefined)} onError={reportUiError} />}
      {providerSetupVisible && settings && providerReadiness && <ProviderSetupModal
        providerOptions={providerOptions}
        readiness={providerReadiness}
        settings={settings}
        onClose={() => setProviderSetupDismissed(true)}
        onConfigured={configureProvider}
      />}
    </main>
  )

  function appendAssistant(text: string) {
    setItems((current) => {
      const last = current.at(-1)
      if (last?.kind === "assistant") return current.map((item) => item.id === last.id && item.kind === "assistant" ? { ...item, text: item.text + text } : item)
      return [...current, { id: crypto.randomUUID(), kind: "assistant", text, time: currentTime() }]
    })
  }

  function appendTool(title: string, detail: string, status: "running" | "done") {
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "tool", title, detail, status, open: false }])
  }

  function appendStatus(text: string) {
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "status", text }])
  }

  function enqueueQueuedInput(text: string) {
    const input = createQueuedRunInput({
      text,
      mode: runMode,
      permissionMode,
      images: attachments.filter((file) => file.kind === "image").map((file) => file.path),
      files: attachments.filter((file) => file.kind === "file").map((file) => file.path),
    }, crypto.randomUUID(), Date.now())
    const next = [...queuedInputsRef.current, input]
    queuedInputsRef.current = next
    setQueuedInputs(next)
    const summary = `Queued next input: ${shortQueuedPrompt(text)}`
    appendStatus(summary)
    updateProgress({ ...progressRef.current, summary: `${summary} (${queuedInputLabel(next.length)}).` })
  }

  function flushQueuedInput() {
    const { next: nextInput, remaining } = dequeueQueuedRunInput(queuedInputsRef.current, runningRef.current)
    if (!nextInput) return
    queuedInputsRef.current = remaining
    setQueuedInputs(remaining)
    appendStatus(`Running queued input: ${shortQueuedPrompt(nextInput.text)}`)
    void submitInput(nextInput.text, "queue", nextInput)
  }

  function updateProgress(next: Progress) {
    progressRef.current = next
    setProgress(next)
  }

  function reportUiError(error: unknown, prefix?: string) {
    const message = errorMessage(error)
    const text = prefix ? `${prefix} ${message}` : message
    appendStatus(text)
    updateProgress({ ...progressRef.current, status: "failed", summary: text })
  }

  function upsertSessionPreview(session: string, title: string) {
    setSessions((current) => upsertSessionPreviewState(current, session, title))
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function SidebarGroup({ action, children, onAction, title }: { action?: string; children: React.ReactNode; onAction?: () => void; title: string }) {
  return <section className="sidebar-group"><div className="group-title"><span>{title}</span>{action && <button onClick={onAction}>{action}</button>}</div>{children}</section>
}

function ProgressCard({ progress, running }: { progress: Progress; running: boolean }) {
  return <section className="progress-card">
    <div className="progress-meta"><span><span className={`status-dot ${running ? "blue" : progress.status === "failed" ? "red" : "green"}`} />{displayRunStatus(progress.status)}</span><span>{progress.startedAt ? elapsed(progress.startedAt) : "00:00"}</span></div>
    <div className="run-facts">
      <span>provider: {progress.provider ?? "-"}</span>
      <span>mode: {progress.mode ?? "-"}</span>
      <span>tools: {progress.toolResults}/{progress.toolCalls}</span>
    </div>
    <div className="progress-summary">{progress.summary}</div>
  </section>
}

function EmptyState() {
  return <section className="empty-state"><h2>No messages yet.</h2><p>Start a local EasyCode session in this workspace.</p></section>
}

function Message({ item }: { item: Exclude<ChatItem, { kind: "tool" }> }) {
  if (item.kind === "status") return <article className="message status"><MarkdownText text={item.text} /></article>
  return <article className={`message ${item.kind}`}><div className="message-head"><strong>{item.kind === "user" ? "You" : "EasyCode"}</strong><time>{item.time}</time></div><MessageText text={item.text || "..."} /></article>
}

function MessageText({ text }: { text: string }) {
  return <div className="message-body">
    {splitReasoningBlocks(text).map((part, index) => part.kind === "reasoning"
      ? <ReasoningBlock key={`${part.kind}-${index}`} text={part.text} />
      : <MarkdownText key={`${part.kind}-${index}`} text={part.text} />)}
  </div>
}

function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return <section className={`reasoning-fold ${open ? "open" : ""}`}>
    <button onClick={() => setOpen((value) => !value)}>
      <span>Reasoning</span>
      <small>{open ? "Hide" : reasoningPreview(text)}</small>
    </button>
    {open && <MarkdownText text={text} />}
  </section>
}

function ToolRow({ item, onToggle }: { item: Extract<ChatItem, { kind: "tool" }>; onToggle: (id: string) => void }) {
  return <article className="tool-row"><button onClick={() => onToggle(item.id)}><span className={`status-dot ${item.status === "done" ? "green" : "blue"}`} />{item.title}<span>{item.status === "done" ? "Completed" : "Running"}</span></button>{item.open && <pre>{item.detail}</pre>}</article>
}

function Composer({ attachments, onClearAttachments, onPickFiles, onRemoveAttachment, permissionMode, prompt, providerReady, providerReadiness, queuedCount, runMode, running, sendPrompt, setPermissionMode, setPrompt, setRunMode }: {
  attachments: Attachment[]
  onClearAttachments: () => Promise<void>
  onPickFiles: () => void
  onRemoveAttachment: (id: string) => void
  permissionMode: PermissionMode
  prompt: string
  providerReady: boolean
  providerReadiness?: DesktopProviderReadiness
  queuedCount: number
  runMode: RunMode
  running: boolean
  sendPrompt: () => void
  setPermissionMode: (mode: PermissionMode) => void
  setPrompt: (value: string) => void
  setRunMode: (mode: RunMode) => void
}) {
  const trimmedPrompt = prompt.trim()
  const isLocalSlash = trimmedPrompt.startsWith("/") && !trimmedPrompt.startsWith("//") && !isRunProducingSlashInput(trimmedPrompt)
  const isCancelInput = isCancelRunInput(prompt)
  const willQueue = shouldQueueRunInput(prompt, running)
  const blockedByProvider = !running && !providerReady && !isLocalSlash
  return <footer className="composer">
    {attachments.length > 0 && <div className="attachments-wrap">
      <div className="attachments-head"><span>{attachments.length} attached</span><button onClick={() => { void onClearAttachments() }} disabled={running}>Clear all</button></div>
      <div className="attachments">{attachments.map((file) => <button key={file.id} onClick={() => onRemoveAttachment(file.id)} disabled={running}><span>{file.name}</span><small>{file.kind} - {file.size}</small></button>)}</div>
    </div>}
    <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendPrompt()
    }} placeholder="Ask EasyCode to inspect, explain, plan, or change this repository." />
    <div className="composer-bar">
      <button className="file-button" onClick={onPickFiles} disabled={running}>Add files</button>
      <div className="mode-toggle" role="group" aria-label="Run mode">
        <button className={runMode === "build" ? "selected" : ""} onClick={() => setRunMode("build")} disabled={running}>Build</button>
        <button className={runMode === "plan" ? "selected" : ""} onClick={() => setRunMode("plan")} disabled={running}>Plan</button>
        <button className={runMode === "goal" ? "selected" : ""} onClick={() => setRunMode("goal")} disabled={running}>Goal</button>
      </div>
      {runMode === "goal"
        ? <div className="permission-static" title="Goal mode uses the same restricted permission policy as the CLI goal automation.">Goal restricted</div>
        : <div className="permission-toggle" role="group" aria-label="Permission mode">
          <button className={permissionMode === "ask" ? "selected" : ""} onClick={() => setPermissionMode("ask")} disabled={running}>Ask</button>
          <button className={permissionMode === "auto-review" ? "selected" : ""} onClick={() => setPermissionMode("auto-review")} disabled={running}>Auto-review</button>
        </div>}
      {blockedByProvider && <span className="composer-warning">{providerReadiness ? providerReadinessLabel(providerReadiness) : "Provider not ready"}</span>}
      {queuedCount > 0 && <span className="queue-chip">{queuedInputLabel(queuedCount)}</span>}
      <button className="send-button" onClick={sendPrompt} disabled={!prompt.trim() || blockedByProvider}>{running ? isCancelInput ? "Cancel" : willQueue ? "Queue" : "Send" : "Send"}</button>
    </div>
  </footer>
}

function Panel({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="rail-panel"><div className="panel-title"><h2>{title}</h2></div>{children}</section>
}

function CommandPanel({ commands, onRun, running }: { commands: DesktopQuickSlashCommand[]; onRun: (command: DesktopQuickSlashCommand) => void; running: boolean }) {
  return <Panel title="Commands">
    <div className="command-grid">
      {commands.map((command) => <button key={command.command} onClick={() => onRun(command)} disabled={!canRunDesktopQuickSlashCommand(command, running)}>{command.label}</button>)}
    </div>
  </Panel>
}

function PlanPanel({ onClear, planStatus, running }: { onClear: () => void; planStatus?: DesktopPlanStatusResult; running: boolean }) {
  const plan = planStatus?.plan?.plan
  const checkpoint = planStatus?.plan?.checkpoint
  const completed = checkpoint ? Object.values(checkpoint.stepStatuses).filter((status) => status === "completed").length : 0
  const total = plan?.steps.length ?? 0
  const current = plan?.steps.find((step) => step.id === planStatus?.currentStepId)
  return <Panel title="Plan">
    {!planStatus?.planId && <div className="empty-list compact">No active plan</div>}
    {planStatus?.planId && <div className="plan-box">
      <strong>{plan?.title ?? planStatus.planId}</strong>
      <div className="goal-meta">
        <span>{planStatus.status ?? checkpoint?.status ?? "unknown"}</span>
        <span>{completed}/{total} steps</span>
        {plan?.lowRisk && <span>low risk</span>}
      </div>
      {current && <small>{current.goal}</small>}
      {planStatus.blocker && <p>{planStatus.blocker}</p>}
      <button onClick={onClear} disabled={running}>Clear Plan</button>
    </div>}
  </Panel>
}

function GoalPanel({ goal, onClear, onPause, onResume, running }: { goal?: DesktopGoalState; onClear: () => void; onPause: () => void; onResume: () => void; running: boolean }) {
  const canPause = Boolean(goal && goal.status !== "paused" && goal.status !== "completed")
  const canResume = Boolean(goal && (goal.status === "paused" || goal.status === "blocked"))
  return <Panel title="Goal">
    {!goal && <div className="empty-list compact">No active goal</div>}
    {goal && <div className="goal-box">
      <strong>{goal.objective}</strong>
      <div className="goal-meta">
        <span>{goal.status}</span>
        <span>iteration {goal.iteration}</span>
      </div>
      {goal.firstSlice && <small>{goal.firstSlice}</small>}
      {goal.blocker && <p>{goal.blocker}</p>}
      <div className="goal-actions">
        <button onClick={onPause} disabled={running || !canPause}>Pause</button>
        <button onClick={onResume} disabled={running || !canResume}>Resume</button>
        <button onClick={onClear} disabled={running}>Clear</button>
      </div>
    </div>}
  </Panel>
}

function SkillsPanel({ onClear, onToggle, running, selected, skills }: { onClear: () => void; onToggle: (skill: DesktopSkillInfo) => void; running: boolean; selected: string[]; skills: DesktopSkillInfo[] }) {
  const [expanded, setExpanded] = useState(false)
  const selectedSet = new Set(selected)
  const visible = expanded ? skills : skills.slice(0, 8)
  return <Panel title="Skills">
    <div className="panel-inline-actions"><span>{selected.length} active</span><button onClick={onClear} disabled={running || selected.length === 0}>Clear Skills</button></div>
    {skills.length === 0 && <div className="empty-list compact">No skills found</div>}
    {visible.length > 0 && <div className="skill-list">
      {visible.map((skill) => {
        const active = selectedSet.has(skill.id) || selectedSet.has(skill.name)
        return <button key={skill.id} className={`skill-row ${active ? "active" : ""}`} onClick={() => onToggle(skill)} disabled={running}>
          <span>{active ? "On" : "Off"}</span>
          <strong>{skill.name}</strong>
          <small>{skill.description}</small>
        </button>
      })}
    </div>}
    {skills.length > 8 && <button className="more-row" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : `Show all ${skills.length} skills`}</button>}
  </Panel>
}

function InfoRow({ detail, label, status, value }: { detail?: string; label: string; status?: "ok" | "warn"; value: string }) {
  return <div className="info-row"><div><span>{label}</span>{detail && <small>{detail}</small>}</div><strong className={status}>{value}</strong></div>
}

function EditableRow({ label, onCommit, placeholder, value }: { label: string; onCommit: (value: string) => void; placeholder: string; value: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <label className="editable-row"><span>{label}</span><input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={() => onCommit(draft)} /></label>
}

function SelectRow({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string }) {
  const values = options.includes(value) ? options : [value, ...options].filter(Boolean)
  return <label className="editable-row"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{values.map((option) => <option value={option} key={option}>{option}</option>)}</select></label>
}

function ToggleRow({ label, onChange, value }: { label: string; onChange: (value: boolean) => void; value: boolean }) {
  return <div className="editable-row"><span>{label}</span><button className={`toggle-button ${value ? "on" : ""}`} onClick={() => onChange(!value)}>{value ? "On" : "Off"}</button></div>
}

function NumberRow({ fallback, label, onCommit, value }: { fallback: number; label: string; onCommit: (value: number | undefined) => void; value?: number }) {
  const [draft, setDraft] = useState(String(value ?? fallback))
  useEffect(() => setDraft(String(value ?? fallback)), [fallback, value])
  return <label className="editable-row"><span>{label}</span><input value={draft} inputMode="numeric" onChange={(event) => setDraft(event.target.value)} onBlur={() => {
    const next = Number(draft)
    onCommit(Number.isFinite(next) && next > 0 ? Math.round(next) : undefined)
  }} /></label>
}

function ProviderSetupModal({ onClose, onConfigured, providerOptions, readiness, settings }: {
  onClose: () => void
  onConfigured: (input: DesktopProviderSetup) => Promise<DesktopProviderSetupResult>
  providerOptions: string[]
  readiness: DesktopProviderReadiness
  settings: DesktopSettings
}) {
  const options = providerOptions.length > 0 ? providerOptions : ["deepseek", "openai", "openai-compatible"]
  const [provider, setProvider] = useState(options.includes(settings.provider) ? settings.provider : options[0])
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState(settings.model ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const requirements = providerSetupRequirements(provider, readiness)
  const status = providerSetupStatus(provider, readiness, requirements)
  const canSave = !saving && (!requirements.apiKeyRequired || apiKey.trim().length > 0) && (!requirements.baseUrlRequired || baseUrl.trim().length > 0)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError("")
    try {
      await onConfigured({
        provider,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      })
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setSaving(false)
    }
  }
  return <div className="modal"><section className="setup-modal">
    <form onSubmit={submit}>
      <div>
        <h2>Configure provider</h2>
        <p>EasyCode needs a local provider configuration before it can run this workspace.</p>
      </div>
      <div className="setup-status">
        <span>{status.label}</span>
        <small>{status.detail}</small>
      </div>
      <label className="setup-field">
        <span>Provider</span>
        <select value={provider} onChange={(event) => {
          const next = event.target.value
          setProvider(next)
          setModel(defaultSetupModel(next))
          setBaseUrl("")
        }}>
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label className="setup-field">
        <span>{requirements.apiKeyEnv}</span>
        <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={requirements.apiKeyRequired ? "Required" : "Already configured, optional to replace"} autoFocus={requirements.apiKeyRequired} />
      </label>
      {requirements.baseUrlEnv && <label className="setup-field">
        <span>{requirements.baseUrlEnv}</span>
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1/chat/completions" autoFocus={requirements.baseUrlRequired && !requirements.apiKeyRequired} />
      </label>}
      <label className="setup-field">
        <span>Model</span>
        <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={defaultSetupModel(provider)} />
      </label>
      <small>Saved locally to ~/.easycode/.env and reused by the CLI.</small>
      {error && <p className="setup-error">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={onClose} className="secondary">Later</button><button disabled={!canSave}>{saving ? "Saving" : "Save and continue"}</button></div>
    </form>
  </section></div>
}

function PermissionModal({ onClose, onError, prompt }: { prompt: PermissionPrompt; onClose: () => void; onError: (error: unknown, prefix?: string) => void }) {
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const reply = async (action: PermissionReplyAction) => {
    setSubmitting(true)
    setError("")
    try {
      await window.easycode.replyPermission(prompt.requestId, sidecarPermissionReply(action))
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      onError(error, "Permission reply failed.")
    } finally {
      setSubmitting(false)
    }
  }
  return <div className="modal"><section><h2>Permission request</h2><p>{prompt.title}</p><small>{prompt.detail}</small>{error && <p className="setup-error">{error}</p>}<div className="modal-actions"><button onClick={() => reply("reject")} className="secondary" disabled={submitting}>Reject</button><button onClick={() => reply("approve")} disabled={submitting}>Approve</button></div></section></div>
}

function PlanModal({ onClose, onError, prompt }: { prompt: PlanPrompt; onClose: () => void; onError: (error: unknown, prefix?: string) => void }) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const hasDraft = canSubmitPlanDraft(draft)
  const reply = async (action: PlanReplyAction) => {
    setSubmitting(true)
    setError("")
    try {
      const payload = planReplyPayload(action, draft)
      await window.easycode.replyPlan(prompt.runId, payload.action, payload.text)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      onError(error, "Plan reply failed.")
    } finally {
      setSubmitting(false)
    }
  }
  return <div className="modal"><section><h2>Approve plan</h2><div className="plan-preview"><MarkdownText text={prompt.markdown} /></div><textarea className="plan-reply" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Describe plan changes, or enter a new prompt." />{error && <p className="setup-error">{error}</p>}<div className="modal-actions"><button onClick={() => reply("reject")} className="secondary" disabled={submitting}>Reject</button><button onClick={() => reply("new_prompt")} className="secondary" disabled={!hasDraft || submitting}>New prompt</button><button onClick={() => reply("edit")} className="secondary" disabled={!hasDraft || submitting}>Edit plan</button><button onClick={() => reply("approve")} disabled={submitting}>Approve</button></div></section></div>
}

function currentTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function elapsed(startedAt: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

function displayRunStatus(status: RunStatus) {
  if (status === "waiting_plan") return "Waiting for plan"
  if (status === "waiting_permission") return "Waiting for permission"
  return status[0].toUpperCase() + status.slice(1)
}

function providerReadinessLabel(readiness: DesktopProviderReadiness | undefined) {
  if (!readiness) return "Unknown"
  if (readiness.status === "ready") return "Ready"
  if (readiness.status === "missing_env") return "Missing config"
  if (readiness.status === "unknown_provider") return "Unknown"
  return "Invalid"
}

function providerReadinessDetail(readiness: DesktopProviderReadiness | undefined) {
  if (!readiness) return "Not checked yet"
  if (readiness.missingEnv.length > 0) return `Missing ${readiness.missingEnv.join(", ")}`
  return readiness.reason ?? readiness.model
}

function sidecarStatusLabel(status: DesktopSidecarStatus | undefined) {
  if (!status) return "Unknown"
  if (status.running) return "Running"
  if (status.exists === false) return "Missing"
  if (status.exists === undefined) return "PATH"
  return "Ready"
}

function sidecarStatusDetail(status: DesktopSidecarStatus | undefined) {
  if (!status) return "Not checked yet"
  if (status.exists === false) return status.path
  if (status.exists === undefined) return `Command lookup: ${status.path}`
  return status.path
}

function sidecarStatusTone(status: DesktopSidecarStatus | undefined) {
  if (!status) return undefined
  if (status.running || status.exists === true || status.exists === undefined) return "ok"
  return "warn"
}

function sidecarStatusDot(status: DesktopSidecarStatus | undefined) {
  if (status?.running) return "green"
  if (status?.exists === false) return "red"
  return "blue"
}

function providerReadinessError(readiness: DesktopProviderReadiness) {
  const detail = providerReadinessDetail(readiness)
  return detail ? `${providerReadinessLabel(readiness)}: ${detail}` : providerReadinessLabel(readiness)
}

function providerSetupRequirements(provider: string, readiness: DesktopProviderReadiness) {
  const missing = readiness.provider === provider ? new Set(readiness.missingEnv) : undefined
  if (provider === "openai") {
    return { apiKeyEnv: "OPENAI_API_KEY", apiKeyRequired: missing ? missing.has("OPENAI_API_KEY") : true, baseUrlEnv: undefined, baseUrlRequired: false }
  }
  if (provider === "openai-compatible") {
    return {
      apiKeyEnv: "OPENAI_COMPAT_API_KEY",
      apiKeyRequired: missing ? missing.has("OPENAI_COMPAT_API_KEY") : true,
      baseUrlEnv: "OPENAI_COMPAT_API_URL",
      baseUrlRequired: missing ? missing.has("OPENAI_COMPAT_API_URL") : true,
    }
  }
  return { apiKeyEnv: "DEEPSEEK_API_KEY", apiKeyRequired: missing ? missing.has("DEEPSEEK_API_KEY") : true, baseUrlEnv: undefined, baseUrlRequired: false }
}

function providerSetupStatus(provider: string, readiness: DesktopProviderReadiness, requirements: ReturnType<typeof providerSetupRequirements>) {
  if (readiness.provider === provider) {
    return {
      label: providerReadinessLabel(readiness),
      detail: providerReadinessDetail(readiness) ?? provider,
    }
  }
  const keys = [requirements.apiKeyEnv, requirements.baseUrlEnv].filter(Boolean).join(" and ")
  return {
    label: "Configuration required",
    detail: `Enter ${keys} to switch to ${provider}.`,
  }
}

function defaultSetupModel(provider: string) {
  if (provider === "openai") return "gpt-5.5"
  if (provider === "openai-compatible") return "openai-compatible"
  return "deepseek-v4-pro"
}

function isAttachmentAction(action: Extract<DesktopSlashCommandResult, { handled: true }>["action"]): action is AttachmentAction {
  return action?.type === "addImage" || action?.type === "clearImages" || action?.type === "addFile" || action?.type === "clearFiles"
}

function aheadBehind(status: DesktopWorkspaceStatus | undefined) {
  if (!status) return undefined
  const parts = []
  if (status.ahead) parts.push(`ahead ${status.ahead}`)
  if (status.behind) parts.push(`behind ${status.behind}`)
  return parts.join(", ") || undefined
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function workspaceDisplayName(root: string) {
  return root.split(/[\\/]/).filter(Boolean).at(-1) || root
}

function sessionTitle(session: DesktopSessionSummary) {
  const title = (session.title || session.id).trim()
  return truncateSessionTitle(title)
}

function splitReasoningBlocks(text: string) {
  const parts: Array<{ kind: "markdown" | "reasoning"; text: string }> = []
  let remaining = text
  while (remaining) {
    const startMatch = remaining.match(/<\s*reasoning\s*>/i)
    const start = startMatch?.index ?? -1
    if (start === -1) {
      if (remaining) parts.push({ kind: "markdown", text: cleanControlTags(remaining) })
      break
    }
    if (start > 0) parts.push({ kind: "markdown", text: cleanControlTags(remaining.slice(0, start)) })
    const contentStart = start + startMatch![0].length
    const afterStart = remaining.slice(contentStart)
    const endMatch = afterStart.match(/<\s*\/\s*reasoning\s*>/i)
    if (!endMatch || endMatch.index === undefined) {
      parts.push({ kind: "reasoning", text: remaining.slice(contentStart).trim() })
      break
    }
    parts.push({ kind: "reasoning", text: afterStart.slice(0, endMatch.index).trim() })
    remaining = afterStart.slice(endMatch.index + endMatch[0].length)
  }
  return parts.filter((part) => part.text.trim().length > 0)
}

function cleanControlTags(text: string) {
  return text
    .replace(/<\s*tool_call\b[^>]*>/gi, "")
    .replace(/<\s*\/\s*tool_call\s*>/gi, "")
    .replace(/<\s*tool_call\s+list\s*>/gi, "")
}

function reasoningPreview(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return "Show thoughts"
  return Array.from(compact).length > 54 ? `${Array.from(compact).slice(0, 54).join("")}...` : compact
}

function messagesToItems(messages: DesktopMessage[]): ChatItem[] {
  return messages.flatMap((message): ChatItem[] => {
    if (message.role === "tool") return message.parts.flatMap((part) => toolPartToItem(message, part))
    if (message.role !== "user" && message.role !== "assistant") return []
    return [{
      id: message.id,
      kind: message.role,
      text: message.parts.map(partToText).filter(Boolean).join("\n"),
      time: new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }]
  })
}

function toolPartToItem(message: DesktopMessage, part: DesktopMessagePart): ChatItem[] {
  if (part.type === "tool_call") {
    return [{ id: `${message.id}-${part.call.id}`, kind: "tool", title: part.call.name, detail: JSON.stringify(part.call.input, null, 2), status: part.status === "running" ? "running" : "done", open: false }]
  }
  if (part.type === "tool_result") {
    return [{ id: `${message.id}-${part.callID}`, kind: "tool", title: part.toolName, detail: part.output, status: part.status === "succeeded" ? "done" : "done", open: false }]
  }
  return []
}

function partToText(part: DesktopMessagePart) {
  if (part.type === "text" || part.type === "summary") return part.text
  if (part.type === "reasoning") return `<reasoning>\n${part.text}\n</reasoning>`
  if (part.type === "image") return "[image]"
  if (part.type === "tool_call") return ""
  return part.output
}
