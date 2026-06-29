import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { DesktopDeleteSessionResult, DesktopFileSelection, DesktopGoalState, DesktopGoalStatusResult, DesktopListSessionsResult, DesktopListSkillsResult, DesktopLoadSessionResult, DesktopMessage, DesktopMessagePart, DesktopPermissionMode, DesktopPlanStatusResult, DesktopProviderListResult, DesktopProviderReadiness, DesktopProviderSetup, DesktopProviderSetupResult, DesktopReasoningEffort, DesktopRunMode, DesktopSessionSummary, DesktopSettings, DesktopSkillInfo, DesktopSlashCommandResult, DesktopWorkspaceStatus, SidecarFrame } from "../shared/protocol.js"
import { applyAttachmentAction, clearAttachmentSlashCommands, pickedFileSlashCommands, rejectedWorkspaceFileSummary, removeFileRefs, type AttachmentAction, type DesktopAttachment } from "./attachment-state.js"
import { permissionPromptAfterRunDone, permissionRunSnapshot, permissionUiAfterRequest, sidecarPermissionReply, type PermissionReplyAction, type PermissionRunSnapshot } from "./permission-state.js"
import { canSubmitPlanDraft, displayPlanMarkdown, goalAfterLifecycleEvent, goalLifecycleSummary, planReplyPayload, planStatusFromResult, runStatusForGoalPhase, runStatusFromGoalControlResult, runStatusFromRunDone, shouldClearBlockingPromptsAfterRunDone, shouldReloadSessionAfterGoalControl, shouldReloadSessionAfterGoalLifecycle, shouldReloadSessionAfterRunDone, type PlanReplyAction } from "./plan-goal-state.js"
import { composerStateAfterQueuedInput, createQueuedRunInput, dequeueQueuedRunInput, isCancelRunInput, isRunProducingSlashInput, queuedInputLabel, shortQueuedPrompt, shouldDetachActiveRunForWorkspaceSwitch, shouldQueueRunInput, type QueuedRunInput } from "./run-queue.js"
import { readDesktopSessionSelection, resolveStartupSession, resolveStartupWorkspace, writeDesktopSessionSelection } from "./session-selection-state.js"
import { draftSessionId as createDraftSessionId, draftSessionPromptPlan, mergeSessionListPreservingOrder, planWorkspaceRemoval, removeSessionPreview, sessionIdFromPrompt, sessionSwitchSlashCommand, titleFromPrompt, truncateSessionTitle, upsertSessionPreview as upsertSessionPreviewState, workspaceRemovalClearsDraft, workspaceRoots, workspaceSwitchPatch } from "./session-workspace-state.js"
import { effortSettingsCommand, languageSettingsCommand, maxStepsSettingsCommand, maxTokensSettingsCommand, modelSettingsCommand, providerSettingsCommand, thinkingSettingsCommand } from "./settings-commands.js"
import { applyDirectDesktopSettings, reconcileDesktopSettingsFromSidecar, restoreLoadedSessionSettings } from "./settings-sync.js"

type ChatItem =
  | { id: string; kind: "user"; text: string; time: string }
  | { id: string; kind: "assistant"; text: string; time: string; pending?: boolean }
  | { id: string; kind: "tool"; title: string; detail: string; status: "running" | "done"; open: boolean }
  | { id: string; kind: "status"; text: string }

type ToolItem = Extract<ChatItem, { kind: "tool" }>
type MessageItem = Exclude<ChatItem, ToolItem>
type AssistantTurnPart =
  | { id: string; kind: "assistant"; item: Extract<ChatItem, { kind: "assistant" }> }
  | { id: string; kind: "tools"; tools: ToolItem[] }
type AssistantRenderPart =
  | AssistantTurnPart
  | { id: string; kind: "activity"; parts: AssistantTurnPart[] }
type StreamEntry =
  | { id: string; kind: "message"; item: Exclude<MessageItem, { kind: "assistant" }> }
  | { id: string; kind: "assistantTurn"; time: string; parts: AssistantTurnPart[] }

type PermissionMode = DesktopPermissionMode
type PermissionPrompt = { requestId: string; title: string; detail: string; workspaceRoot?: string }
type PlanPrompt = { runId: string; markdown: string; workspaceRoot?: string }
type Attachment = DesktopAttachment
type MarkdownFileOpenHandler = (filePath: string) => Promise<void>
type DesktopCopy = ReturnType<typeof desktopCopy>
type RunStatus = "idle" | "running" | "waiting_plan" | "waiting_permission" | "done" | "failed" | "blocked" | "cancelled"
type Progress = { status: RunStatus; startedAt?: number; summary: string; provider?: string; model?: string; mode?: string; toolCalls: number; toolResults: number }
type RunMode = DesktopRunMode
type SelectOption = { value: string; label: string }

const noopOpenFile: MarkdownFileOpenHandler = async () => undefined

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
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, DesktopSessionSummary[]>>({})
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
  const [progress, setProgress] = useState<Progress>({ status: "idle", summary: "Ready for a local run.", toolCalls: 0, toolResults: 0 })
  const streamRef = useRef<HTMLDivElement>(null)
  const nextStreamScrollRef = useRef<"instant" | "smooth">("smooth")
  const progressRef = useRef<Progress>(progress)
  const settingsRef = useRef<DesktopSettings | undefined>(undefined)
  const runningRef = useRef(false)
  const draftSessionRef = useRef(false)
  const queuedInputsRef = useRef<QueuedRunInput[]>([])
  const activeRunWorkspaceRef = useRef<string | undefined>(undefined)
  const workspaceSwitchingRef = useRef(false)
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
        const restored = await restoreStartupSelection(next)
        setSettings(restored)
        settingsRef.current = restored
      }
      await refreshAll(settingsRef.current?.session ?? initialized.session)
    }).catch((error) => {
      reportUiError(error, "Sidecar initialize failed.")
    })
    return off
  }, [])

  useLayoutEffect(() => {
    const stream = streamRef.current
    if (!stream) return
    const behavior = nextStreamScrollRef.current
    nextStreamScrollRef.current = "smooth"
    if (behavior === "instant") {
      stream.scrollTop = stream.scrollHeight
      return
    }
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" })
  }, [items])

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
  const sessions = settings?.workspaceRoot ? sessionsByWorkspace[settings.workspaceRoot] ?? [] : []
  const currentSession = sessions.find((session) => session.id === settings?.session)
  const fullPromptTitle = useMemo(() => firstDisplayUserTitle(items), [items])
  const streamEntries = useMemo(() => groupStreamItems(items), [items])
  const copy = desktopCopy(settings?.language)
  const activeSessionTitle = safeSessionTitle(draftSession ? copy.newChat : fullPromptTitle || (currentSession ? fullSessionTitle(currentSession) : draftSessionTitle || settings?.session || copy.defaultSessionTitle))
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
      void refreshGoalStatus()
      if (shouldReloadSessionAfterGoalLifecycle(event.phase)) {
        void syncCurrentSessionMessages(undefined, { preserveVisible: true }).catch((error) => reportUiError(error, "Goal session sync failed."))
        void refreshPlanStatus()
        void refreshSessions()
      }
    } else if (event.type === "text_delta") appendAssistant(event.text)
    else if (event.type === "tool_call") {
      updateProgress({ ...progressRef.current, status: "running", startedAt: progressRef.current.startedAt ?? Date.now(), summary: `Running ${event.call.name}.`, toolCalls: progressRef.current.toolCalls + 1 })
      appendTool(event.call.name, JSON.stringify(event.call.input, null, 2), "running")
    } else if (event.type === "tool_result") {
      updateProgress({ ...progressRef.current, status: "running", startedAt: progressRef.current.startedAt ?? Date.now(), summary: `${event.title || event.toolName} completed.`, toolResults: progressRef.current.toolResults + 1 })
      if (isPlanControlTool(event.toolName)) void refreshPlanStatus()
      else if (isGoalControlTool(event.toolName)) void refreshGoalStatus()
      else appendTool(event.title || event.toolName, event.output, "done")
    } else if (event.type === "permission_request") {
      const nextPermission = permissionUiAfterRequest(activePermissionRef.current.effectiveMode, event.request)
      if (nextPermission.prompt) {
        updateProgress({ ...progressRef.current, status: nextPermission.progressStatus, summary: nextPermission.progressSummary })
        setPermission(nextPermission.prompt ? { ...nextPermission.prompt, workspaceRoot: settingsRef.current?.workspaceRoot } : undefined)
      } else {
        appendStatus(nextPermission.statusText)
        void window.easycode.replyPermission(event.request.id, nextPermission.autoReply, settingsRef.current?.workspaceRoot).catch((error) => reportUiError(error, "Permission auto-reply failed."))
      }
    } else if (event.type === "plan_approval_request") {
      updateProgress({ ...progressRef.current, status: "waiting_plan", startedAt: progressRef.current.startedAt ?? Date.now(), summary: "Plan is waiting for approval." })
      setPlan({ runId: frame.runId!, markdown: event.markdown, workspaceRoot: settingsRef.current?.workspaceRoot })
    } else if (event.type === "provider_metrics") {
      updateProgress({ ...progressRef.current, status: "running", startedAt: progressRef.current.startedAt ?? Date.now(), summary: `${event.metrics.provider} metrics received.`, provider: event.metrics.provider, model: event.metrics.model })
    } else if (event.type === "failure") {
      updateProgress({ ...progressRef.current, status: "failed", summary: event.text })
    } else if (event.type === "run_done") {
      setRunning(false)
      runningRef.current = false
      activeRunWorkspaceRef.current = undefined
      if (shouldClearBlockingPromptsAfterRunDone(event.status)) {
        setPermission((current) => permissionPromptAfterRunDone(current, event.status))
        setPlan(undefined)
      }
      updateProgress({ ...progressRef.current, status: runStatusFromRunDone(event.status), startedAt: progressRef.current.startedAt, summary: `Run ${event.status}.` })
      if (shouldReloadSessionAfterRunDone(event.status)) void syncCurrentSessionMessages(undefined, { preserveVisible: true }).catch((error) => reportUiError(error, "Session message sync failed."))
      void refreshWorkspaceStatus()
      void refreshSessions()
      void refreshGoalStatus()
      void refreshPlanStatus()
      void refreshProviderReadiness()
      window.setTimeout(() => flushQueuedInput(), 0)
    } else if (event.type === "fatal") {
      setRunning(false)
      runningRef.current = false
      activeRunWorkspaceRef.current = undefined
      reportUiError(event.message)
    } else if (event.type === "session_changed") {
      if (workspaceSwitchingRef.current) return
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
      const workspaceRoot = settingsRef.current?.workspaceRoot
      try {
        const slash = await window.easycode.executeSlashCommand(text, queuedRunInput?.images.length ?? pendingImageCount(), queuedRunInput?.files.length ?? pendingFileCount(), workspaceRoot) as DesktopSlashCommandResult
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
    const runWorkspaceRoot = settingsRef.current?.workspaceRoot
    setPrompt("")
    setAttachments([])
    setRunning(true)
    runningRef.current = true
    activeRunWorkspaceRef.current = runWorkspaceRoot
    updateProgress({ status: "running", startedAt: Date.now(), summary: "Preparing run context.", toolCalls: 0, toolResults: 0 })
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "user", text, time: currentTime() }, { id: crypto.randomUUID(), kind: "assistant", text: copy.waitingForModel, time: currentTime(), pending: true }])
    try {
      const effectiveRunMode = modeOverride ?? runMode
      const permissionSnapshot = permissionRunSnapshot(effectiveRunMode, queuedRunInput?.permissionMode ?? permissionMode)
      activePermissionRef.current = permissionSnapshot
      await window.easycode.runPrompt(text, effectiveRunMode, images, permissionSnapshot.sidecarMode, files, runWorkspaceRoot)
    } catch (error) {
      if (settingsRef.current?.workspaceRoot !== runWorkspaceRoot) return
      appendStatus(error instanceof Error ? error.message : String(error))
      setRunning(false)
      runningRef.current = false
      activeRunWorkspaceRef.current = undefined
      updateProgress({ ...progressRef.current, status: "failed", summary: error instanceof Error ? error.message : String(error) })
      window.setTimeout(() => flushQueuedInput(), 0)
    }
  }

  const cancelRun = async () => {
    if (!running) return
    updateProgress({ ...progressRef.current, status: "cancelled", summary: "Cancelling run..." })
    try {
      const result = await window.easycode.cancelRun(activeRunWorkspaceRef.current ?? settingsRef.current?.workspaceRoot) as { cancelled?: boolean }
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
    if (result.settings) {
      const next = await reconcileDesktopSettingsFromSidecar(window.easycode, result.settings)
      setSettings(next)
      await refreshSettingsSurfaces()
      updateProgress({ ...progressRef.current, status: "idle", summary: result.title, toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
      return
    }
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
    await refreshAll()
    updateProgress({ ...progressRef.current, status: "idle", summary: result.title, toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
  }

  const applySettingsCommand = async (commandText: string, fallback?: Partial<DesktopSettings>) => {
    try {
      const result = await window.easycode.executeSlashCommand(commandText, pendingImageCount(), pendingFileCount(), settingsRef.current?.workspaceRoot) as DesktopSlashCommandResult
      if (!result.handled) {
        if (fallback) await updateSettings(fallback)
        return
      }
      if (result.settings) {
        const next = await reconcileDesktopSettingsFromSidecar(window.easycode, result.settings)
        setSettings(next)
      }
      await refreshSettingsSurfaces()
      updateProgress({ ...progressRef.current, status: "idle", summary: result.title, toolCalls: progressRef.current.toolCalls, toolResults: progressRef.current.toolResults })
    } catch (error) {
      reportUiError(error)
    }
  }

  const updateSettings = async (patch: Partial<DesktopSettings>) => {
    try {
      const next = await applyDirectDesktopSettings(window.easycode, patch)
      setSettings(next)
      await refreshSettingsSurfaces()
    } catch (error) {
      reportUiError(error, "Settings update failed.")
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
    const workspaceRoot = settingsRef.current?.workspaceRoot
    const result = await window.easycode.listSessions(workspaceRoot) as DesktopListSessionsResult
    setWorkspaceSessions(workspaceRoot, (current) => mergeSessionListPreservingOrder(current, result.sessions))
  }

  const restoreStartupSelection = async (settings: DesktopSettings) => {
    const roots = workspaceRoots(settings.workspaceRoot, settings.recentWorkspaces)
    const remembered = readDesktopSessionSelection()
    const workspaceRoot = resolveStartupWorkspace(roots, remembered)
    let next = settings
    if (workspaceRoot && workspaceRoot !== settings.workspaceRoot) {
      next = await window.easycode.updateSettings({ ...settings, workspaceRoot, session: "default" })
      await window.easycode.initialize()
    }

    const listed = await window.easycode.listSessions(next.workspaceRoot) as DesktopListSessionsResult
    const session = resolveStartupSession(listed.sessions, remembered, next.workspaceRoot, listed.currentSession || next.session)
    setWorkspaceSessions(next.workspaceRoot, (current) => mergeSessionListPreservingOrder(current, listed.sessions))
    if (!session) return next

    const loaded = await window.easycode.loadSession(session, next.workspaceRoot) as DesktopLoadSessionResult
    const restored = await restoreLoadedSessionSettings(window.easycode, session, loaded.settings)
    setSessionItems(messagesToItems(loaded.messages))
    rememberSessionSelection(restored.workspaceRoot, session)
    updateProgress({ status: "idle", summary: `Loaded session ${session}.`, toolCalls: 0, toolResults: 0 })
    return restored
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

  const refreshSettingsSurfaces = async () => {
    await Promise.allSettled([
      refreshProviderReadiness(),
      refreshWorkspaceStatus(),
      refreshSkills(),
    ])
  }

  const selectSession = async (session: string) => {
    if (running) return
    if (draftSession && session === draftSessionId) return
    try {
      const switched = await window.easycode.executeSlashCommand(sessionSwitchSlashCommand(session), pendingImageCount(), pendingFileCount(), settingsRef.current?.workspaceRoot) as DesktopSlashCommandResult
      if (!switched.handled) throw new Error(`Session switch was not handled: ${session}`)
      await loadSessionIntoUi(switched.session ?? session, `Loaded session ${switched.session ?? session}.`)
    } catch (error) {
      reportUiError(error, "Session load failed.")
      await refreshSessions()
    }
  }

  const loadSessionIntoUi = async (session: string, summary: string) => {
    const loaded = await window.easycode.loadSession(session, settingsRef.current?.workspaceRoot) as DesktopLoadSessionResult
    setDraftSession(false)
    setDraftSessionId(undefined)
    setDraftSessionTitle("")
    const restored = await restoreLoadedSessionSettings(window.easycode, session, loaded.settings)
    setSettings(restored)
    settingsRef.current = restored
    setSessionItems(messagesToItems(loaded.messages))
    rememberSessionSelection(restored.workspaceRoot, session)
    updateProgress({ status: "idle", summary, toolCalls: 0, toolResults: 0 })
    await refreshAll(session)
  }

  const syncSidecarSession = async (session: string) => {
    const current = settingsRef.current
    if (!current || current.session === session) return
    const loaded = await window.easycode.loadSession(session, current.workspaceRoot) as DesktopLoadSessionResult
    const next = await window.easycode.updateSettings({ ...loaded.settings, session })
    setSettings(next)
    settingsRef.current = next
    setDraftSession(false)
    setDraftSessionId(undefined)
    setDraftSessionTitle("")
    rememberSessionSelection(next.workspaceRoot, session)
    if (!runningRef.current && !draftSessionRef.current) {
      setSessionItems(messagesToItems(loaded.messages))
      updateProgress({ status: "idle", summary: `Loaded session ${session}.`, toolCalls: 0, toolResults: 0 })
    }
  }

  const syncCurrentSessionMessages = async (session = settingsRef.current?.session, options: { preserveVisible?: boolean } = {}) => {
    if (!session) return
    const loaded = await window.easycode.loadSession(session, settingsRef.current?.workspaceRoot) as DesktopLoadSessionResult
    const restored = messagesToItems(loaded.messages)
    if (options.preserveVisible) {
      setItems((current) => current.length > 0 ? current : restored)
      return
    }
    setSessionItems(restored)
  }

  const newSession = async () => {
    if (running) return
    const session = createDraftSessionId()
    try {
      const switched = await window.easycode.executeSlashCommand(sessionSwitchSlashCommand(session), 0, 0, settingsRef.current?.workspaceRoot) as DesktopSlashCommandResult
      if (!switched.handled) throw new Error(`Session create was not handled: ${session}`)
      const createdSession = switched.session ?? session
      const loaded = await window.easycode.loadSession(createdSession, settingsRef.current?.workspaceRoot) as DesktopLoadSessionResult
      const restored = await restoreLoadedSessionSettings(window.easycode, createdSession, loaded.settings)
      setSettings(restored)
      settingsRef.current = restored
      setDraftSession(true)
      draftSessionRef.current = true
      setDraftSessionId(createdSession)
      setDraftSessionTitle("")
      rememberSessionSelection(restored.workspaceRoot, createdSession)
      setWorkspaceSessions(restored.workspaceRoot, (current) => upsertSessionPreviewState(draftSessionId ? removeSessionPreview(current, draftSessionId) : current, createdSession, "New Chat"))
      setSessionItems([])
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
      setWorkspaceSessions(settings?.workspaceRoot, (current) => removeSessionPreview(current, session))
      setDraftSession(false)
      setDraftSessionId(undefined)
      setDraftSessionTitle("")
      setSessionItems([])
      updateProgress({ status: "idle", summary: "Draft session removed.", toolCalls: 0, toolResults: 0 })
      return
    }
    try {
      const result = await window.easycode.deleteSession(session, settingsRef.current?.workspaceRoot) as DesktopDeleteSessionResult
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
    workspaceSwitchingRef.current = true
    try {
      const patch = workspaceSwitchPatch(workspaceRoot)
      if (shouldDetachActiveRunForWorkspaceSwitch(settings?.workspaceRoot, workspaceRoot, runningRef.current)) {
        setRunning(false)
        runningRef.current = false
        activeRunWorkspaceRef.current = undefined
        setQueuedInputs([])
        setPermission(undefined)
        setPlan(undefined)
      }
      setDraftSession(false)
      setDraftSessionId(undefined)
      setDraftSessionTitle("")
      const next = await window.easycode.updateSettings(patch)
      setSettings(next)
      settingsRef.current = next
      await window.easycode.initialize()
      setAttachments([])
      const listed = await window.easycode.listSessions(next.workspaceRoot) as DesktopListSessionsResult
      setWorkspaceSessions(next.workspaceRoot, (current) => mergeSessionListPreservingOrder(current, listed.sessions))
      const session = resolveStartupSession(listed.sessions, readDesktopSessionSelection(), next.workspaceRoot, listed.sessions[0]?.id ?? listed.currentSession ?? patch.session)
      await loadSessionIntoUi(session, `Opened workspace ${workspaceRoot}.`)
    } catch (error) {
      reportUiError(error, "Workspace open failed.")
    } finally {
      workspaceSwitchingRef.current = false
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
        const result = await window.easycode.executeSlashCommand(command, pendingImageCount(), pendingFileCount(), settingsRef.current?.workspaceRoot) as DesktopSlashCommandResult
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
        const result = await window.easycode.executeSlashCommand(command, pendingImageCount(), pendingFileCount(), settingsRef.current?.workspaceRoot) as DesktopSlashCommandResult
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
    rememberSessionSelection(next.workspaceRoot, session)
  }

  return (
    <main className={`shell ${contextRailOpen ? "" : "rail-collapsed"}`}>
      <aside className="sidebar">
        <SidebarGroup title={copy.workspaces} action="+" onAction={addWorkspace}>
          <div className="workspace-list">
            {visibleWorkspaceRoots.map((root) => {
              const active = root === settings?.workspaceRoot
              return <div className={`workspace-card ${active ? "active" : ""}`} key={root}>
                <div className="workspace-head">
                  <button className="workspace-select" onClick={() => selectWorkspace(root)} disabled={active} title={root}>
                    <span className="workspace-title"><strong>{workspaceDisplayName(root)}</strong></span>
                  </button>
                  <button className="icon-button add-session-button" onClick={newSession} disabled={running || !active} aria-label={`${copy.newSession}: ${workspaceDisplayName(root)}`}>+</button>
                  <div className="workspace-menu-host">
                    <button className="icon-button workspace-more" aria-label={`${workspaceDisplayName(root)} menu`}><span>...</span></button>
                    <div className="workspace-menu">
                      <button onClick={() => void runWorkspaceAction(() => window.easycode.showWorkspace(root))}>{copy.showInFinder}</button>
                      <button onClick={() => void runWorkspaceAction(() => removeWorkspace(root))} disabled={running || visibleWorkspaceRoots.length <= 1} className="danger">{copy.removeWorkspace}</button>
                    </div>
                  </div>
                </div>
                {active && <div className="workspace-session-list">
                  {sessions.length === 0 && <div className="empty-list">{copy.noSavedSessions}</div>}
                  {sessions.map((session) => <div className={`thread-row ${(draftSession && session.id === draftSessionId) || (!draftSession && session.id === settings?.session) ? "active" : ""}`} key={session.id}>
                    <button className="thread-select" onClick={() => selectSession(session.id)} disabled={running} title={session.title || session.id}>
                      <span>{sessionTitle(session)}</span>
                    </button>
                    <button className="session-delete" onClick={() => deleteSession(session.id)} disabled={running} aria-label={`Delete ${sessionTitle(session)}`}>×</button>
                  </div>)}
                </div>}
              </div>
            })}
          </div>
        </SidebarGroup>
        <div className="sidebar-footer">
          <div><span className="status-dot green" />{copy.localOnly}</div>
        </div>
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div className="topbar-title">
            <h1 title={activeSessionTitle}>{activeSessionTitle}</h1>
          </div>
          <div className="top-actions">
            <button className="topbar-settings" onClick={() => setContextRailOpen((open) => !open)} aria-label={copy.showSettings} title={copy.showSettings}>⚙</button>
          </div>
        </header>

        <div className="stream" ref={streamRef}>
          {streamEntries.length === 0 && <EmptyState copy={copy} />}
          {streamEntries.map((entry) => entry.kind === "assistantTurn"
            ? <AssistantTurn copy={copy} key={entry.id} entry={entry} onOpenFile={openWorkspaceFileFromMessage} />
            : <Message copy={copy} key={entry.id} item={entry.item} onOpenFile={openWorkspaceFileFromMessage} />)}
        </div>

        <div className="composer-stack">
          <WorkspaceChangesBar copy={copy} goal={goal} planStatus={planStatus} status={workspaceStatus} onOpen={openWorkspaceChanges} />
          <Composer
            attachments={attachments}
            onClearAttachments={clearAttachments}
            copy={copy}
            onPickFiles={pickFiles}
            onRemoveAttachment={removeAttachment}
            permissionMode={permissionMode}
            prompt={prompt}
            providerReady={canStartProviderRun}
            providerReadiness={providerReadiness}
            runMode={runMode}
            running={running}
            settings={settings}
            onCancelRun={cancelRun}
            onChangeEffort={(effort) => applySettingsCommand(effortSettingsCommand(effort))}
            onChangeModel={(model) => applySettingsCommand(modelSettingsCommand(model))}
            setPermissionMode={setPermissionMode}
            setPrompt={setPrompt}
            setRunMode={setRunMode}
            sendPrompt={sendPrompt}
            queuedCount={queuedInputs.length}
          />
        </div>
      </section>

      <aside className={`context-rail ${contextRailOpen ? "open" : "collapsed"}`}>
        {contextRailOpen && <>
          <Panel title={copy.environment}>
            <InfoRow label={copy.workspace} value={workspaceName} detail={settings?.workspaceRoot || copy.notSelected} status="ok" />
            <SelectRow label={copy.provider} value={settings?.provider ?? "deepseek"} options={providerOptions} onChange={(provider) => applySettingsCommand(providerSettingsCommand(provider))} />
            <InfoRow label={copy.providerStatus} value={providerReadinessLabel(providerReadiness)} detail={providerReadinessDetail(providerReadiness)} status={providerReadiness?.status === "ready" ? "ok" : "warn"} />
            <ToggleRow copy={copy} label={copy.thinking} value={settings?.thinking ?? true} onChange={(thinking) => applySettingsCommand(thinkingSettingsCommand(thinking))} />
            <SelectRow label={copy.language} value={settings?.language ?? "en"} options={languageSelectOptions(copy)} onChange={(language) => applySettingsCommand(languageSettingsCommand(language))} />
          </Panel>
          <GitChangesPanel copy={copy} status={workspaceStatus} />
          <Panel title={copy.run}>
            <NumberRow label={copy.maxTokens} value={settings?.maxTokens} fallback={32000} onCommit={(maxTokens) => applySettingsCommand(maxTokensSettingsCommand(maxTokens))} />
            <NumberRow label={copy.maxSteps} value={settings?.maxSteps} fallback={66} onCommit={(maxSteps) => applySettingsCommand(maxStepsSettingsCommand(maxSteps))} />
          </Panel>
          <SkillsPanel copy={copy} skills={skills} selected={settings?.selectedSkills ?? []} running={running} onClear={clearSkills} onToggle={toggleSkill} />
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
      if (last?.kind === "assistant") return current.map((item) => {
        if (item.id !== last.id || item.kind !== "assistant") return item
        if (item.pending) return { ...item, text, pending: false }
        return { ...item, text: item.text + text }
      })
      return [...current, { id: crypto.randomUUID(), kind: "assistant", text, time: currentTime() }]
    })
  }

  function appendTool(title: string, detail: string, status: "running" | "done") {
    if (isPlanControlTool(title) || isGoalControlTool(title)) return
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "tool", title, detail, status, open: false }])
  }

  function appendStatus(text: string) {
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "status", text }])
  }

  async function openWorkspaceFileFromMessage(filePath: string) {
    try {
      await window.easycode.openWorkspaceFile(filePath)
    } catch (error) {
      appendStatus(copy.cannotOpenFile(filePath, errorMessage(error)))
    }
  }

  function openWorkspaceChanges() {
    setContextRailOpen(true)
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
    setWorkspaceSessions(settingsRef.current?.workspaceRoot, (current) => upsertSessionPreviewState(current, session, title))
  }

  function rememberSessionSelection(workspaceRoot: string | undefined, session: string | undefined) {
    if (!workspaceRoot || !session) return
    writeDesktopSessionSelection({ workspaceRoot, session })
  }

  function setWorkspaceSessions(workspaceRoot: string | undefined, update: (current: DesktopSessionSummary[]) => DesktopSessionSummary[]) {
    if (!workspaceRoot) return
    setSessionsByWorkspace((current) => ({
      ...current,
      [workspaceRoot]: update(current[workspaceRoot] ?? []),
    }))
  }

  function setSessionItems(next: ChatItem[]) {
    nextStreamScrollRef.current = "instant"
    setItems(next)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function desktopCopy(language: string | undefined) {
  if (language === "zh") {
    return {
      addFiles: "添加文件",
      acceptance: "验收标准",
      activity: "活动",
      activeCount: (count: number) => `${count} 个启用`,
      ask: "询问",
      attachedCount: (count: number) => `已附加 ${count} 个`,
      attachedImages: "附加图片",
      autoReview: "自动审核",
      binary: "二进制",
      build: "执行",
      callCount: (count: number) => `${count} 次调用`,
      cancel: "取消",
      changedFiles: (count: number) => `${count} 个变更`,
      changes: "变更",
      checks: "检查项",
      clean: "干净",
      clear: "清除",
      clearAll: "全部清除",
      clearPlan: "清除计划",
      clearSkills: "清除技能",
      commands: "命令",
      composerPlaceholder: "让 EasyCode 检查、解释、规划或修改这个仓库。",
      configured: "已配置",
      completed: "已完成",
      cannotOpenFile: (filePath: string, message: string) => `无法打开 ${filePath}：${message}`,
      cannotOpenChanges: (message: string) => `无法打开 Git 变更：${message}`,
      copyOutput: "复制回复",
      defaultSessionTitle: "添加桌面 sidecar 客户端",
      details: "详情",
      duration: "时长",
      effort: "推理强度",
      effortHigh: "高",
      effortLow: "低",
      effortMax: "超高",
      effortMedium: "中",
      environment: "环境",
      gitBranch: "Git 分支",
      goal: "目标",
      goalIteration: (status: string, iteration: number) => `${status} · 第 ${iteration} 轮`,
      goalRestricted: "目标受限",
      goalRestrictedTitle: "Goal 模式使用与 CLI 目标自动化一致的受限权限策略。",
      hide: "收起",
      iteration: (iteration: number) => `第 ${iteration} 轮`,
      language: "语言",
      languageName: (code: string) => ({ en: "英文", zh: "中文", ja: "日文", fr: "法文", ko: "韩文", de: "德文" })[code] ?? code,
      localOnly: "仅本地",
      localRepository: "本地仓库",
      maxSteps: "最大步数",
      maxTokens: "最大 Token",
      missing: "缺失",
      model: "模型",
      modified: "已修改",
      newChat: "新对话",
      newSession: "新建会话",
      noActiveGoal: "没有活动目标",
      noActivePlan: "没有活动计划",
      noMessages: "还没有消息。",
      noPathResolved: "未解析到路径",
      noSavedSessions: "没有已保存会话",
      noSkillsFound: "没有找到技能",
      notSelected: "未选择",
      off: "关",
      on: "开",
      openGitChangesInVscode: "在 VS Code 源代码管理中查看",
      openWorkspaceInVscode: "在 VS Code 中打开工作区",
      pause: "暂停",
      permission: "权限",
      plan: "计划",
      planProgress: (completed: number, total: number) => `计划 ${completed}/${total}`,
      promptContext: "上下文",
      provider: "Provider",
      providerDefault: "Provider 默认",
      providerFact: (provider: string) => `provider: ${provider}`,
      providerNotReady: "Provider 未就绪",
      providerStatus: "Provider 状态",
      queue: "排队",
      referencedFiles: "引用文件",
      reasoning: "推理",
      reasoningCount: (count: number) => `${count} 条推理`,
      refresh: "刷新",
      refreshTitle: "重新同步会话、工作区和 sidecar 状态",
      removeWorkspace: "移除工作区",
      resume: "继续",
      run: "运行",
      running: "运行中",
      runStatus: (status: RunStatus) => {
        if (status === "waiting_plan") return "等待计划"
        if (status === "waiting_permission") return "等待权限"
        if (status === "idle") return "空闲"
        if (status === "running") return "运行中"
        if (status === "done") return "完成"
        if (status === "failed") return "失败"
        if (status === "blocked") return "受阻"
        return "已取消"
      },
      runState: "运行状态",
      send: "发送",
      show: "展开",
      showAllSkills: (count: number) => `显示全部 ${count} 个技能`,
      showInFinder: "在 Finder 中显示",
      showGitChanges: "查看 Git 变更",
      showLess: "收起",
      showSettings: "显示设置",
      sidecar: "Sidecar",
      sidecarPlaceholder: "内置或 PATH 中的 easycode",
      sidecarStatus: "Sidecar 状态",
      skills: "技能",
      startSession: "在这个工作区开始一个本地 EasyCode 会话。",
      state: "状态",
      stepProgress: (current: number, total: number) => `步骤 ${current}/${total}`,
      stopped: "已停止",
      thinking: "思考",
      toolCallCount: (count: number) => `${count} 次工具调用`,
      tools: "工具",
      toolsFact: (done: number, total: number) => `工具: ${done}/${total}`,
      modeFact: (mode: string) => `模式: ${mode}`,
      workspace: "工作区",
      workspaceLower: "工作区",
      workingTree: "工作区状态",
      workspaces: "工作区",
      waitingForModel: "正在准备上下文，等待模型响应...",
      you: "你",
    }
  }
  return {
    addFiles: "Add files",
    acceptance: "Acceptance",
    activity: "Activity",
    activeCount: (count: number) => `${count} active`,
    ask: "Ask",
    attachedCount: (count: number) => `${count} attached`,
    attachedImages: "attached images",
    autoReview: "Auto-review",
    binary: "binary",
    build: "Build",
    callCount: (count: number) => `${count} call${count === 1 ? "" : "s"}`,
    cancel: "Cancel",
    changedFiles: (count: number) => `${count} changed`,
    changes: "Changes",
    checks: "Checks",
    clean: "Clean",
    clear: "Clear",
    clearAll: "Clear all",
    clearPlan: "Clear Plan",
    clearSkills: "Clear Skills",
    commands: "Commands",
    composerPlaceholder: "Ask EasyCode to inspect, explain, plan, or change this repository.",
    configured: "Configured",
    completed: "Completed",
    cannotOpenFile: (filePath: string, message: string) => `Cannot open ${filePath}: ${message}`,
    cannotOpenChanges: (message: string) => `Cannot open Git changes: ${message}`,
    copyOutput: "Copy response",
    defaultSessionTitle: "Add desktop sidecar client",
    details: "details",
    duration: "Duration",
    effort: "Effort",
    effortHigh: "High",
    effortLow: "Low",
    effortMax: "Max",
    effortMedium: "Medium",
    environment: "Environment",
    gitBranch: "Git Branch",
    goal: "Goal",
    goalIteration: (status: string, iteration: number) => `${status} · iter ${iteration}`,
    goalRestricted: "Goal restricted",
    goalRestrictedTitle: "Goal mode uses the same restricted permission policy as the CLI goal automation.",
    hide: "Hide",
    iteration: (iteration: number) => `iteration ${iteration}`,
    language: "Language",
    languageName: (code: string) => ({ en: "English", zh: "Chinese", ja: "Japanese", fr: "French", ko: "Korean", de: "German" })[code] ?? code,
    localOnly: "Local only",
    localRepository: "Local repository",
    maxSteps: "Max Steps",
    maxTokens: "Max Tokens",
    missing: "Missing",
    model: "Model",
    modified: "Modified",
    newChat: "New Chat",
    newSession: "New session",
    noActiveGoal: "No active goal",
    noActivePlan: "No active plan",
    noMessages: "No messages yet.",
    noPathResolved: "No path resolved",
      noSavedSessions: "No saved sessions",
      noSkillsFound: "No skills found",
      notSelected: "Not selected",
    off: "Off",
    on: "On",
    openGitChangesInVscode: "Open Source Control in VS Code",
    openWorkspaceInVscode: "Open workspace in VS Code",
      pause: "Pause",
      permission: "Permission",
    plan: "Plan",
    planProgress: (completed: number, total: number) => `Plan ${completed}/${total}`,
    promptContext: "Prompt Context",
    provider: "Provider",
    providerDefault: "Provider default",
    providerFact: (provider: string) => `provider: ${provider}`,
    providerNotReady: "Provider not ready",
    providerStatus: "Provider Status",
    queue: "Queue",
    referencedFiles: "referenced files",
      reasoning: "Reasoning",
      reasoningCount: (count: number) => `${count} reasoning`,
      refresh: "Refresh",
      refreshTitle: "Sync session, workspace, and sidecar status again",
      removeWorkspace: "Remove Workspace",
    resume: "Resume",
    run: "Run",
    running: "Running",
    runStatus: displayRunStatus,
    runState: "Run State",
    send: "Send",
    show: "Show",
    showAllSkills: (count: number) => `Show all ${count} skills`,
    showInFinder: "Show in Finder",
    showGitChanges: "View Git changes",
    showLess: "Show less",
    showSettings: "Show settings",
    sidecar: "Sidecar",
    sidecarPlaceholder: "Bundled or PATH easycode",
    sidecarStatus: "Sidecar Status",
    skills: "Skills",
    startSession: "Start a local EasyCode session in this workspace.",
    state: "state",
    stepProgress: (current: number, total: number) => `Step ${current}/${total}`,
    stopped: "Stopped",
    thinking: "Thinking",
    toolCallCount: (count: number) => `${count} tool call${count === 1 ? "" : "s"}`,
    tools: "Tools",
    toolsFact: (done: number, total: number) => `tools: ${done}/${total}`,
    modeFact: (mode: string) => `mode: ${mode}`,
    workspace: "Workspace",
    workspaceLower: "workspace",
    workingTree: "Working Tree",
    workspaces: "Workspaces",
    waitingForModel: "Preparing context and waiting for the model...",
    you: "You",
  }
}

function groupStreamItems(items: ChatItem[]): StreamEntry[] {
  const entries: StreamEntry[] = []
  let pendingTools: ToolItem[] = []
  let pendingAssistantParts: AssistantTurnPart[] = []

  const flushTools = () => {
    if (pendingTools.length === 0) return
    pendingAssistantParts.push({ id: `tools-${pendingTools[0].id}-${pendingTools[pendingTools.length - 1].id}`, kind: "tools", tools: pendingTools })
    pendingTools = []
  }

  const flushAssistantTurn = () => {
    flushTools()
    if (pendingAssistantParts.length === 0) return
    const first = pendingAssistantParts[0]
    const last = pendingAssistantParts[pendingAssistantParts.length - 1]
    const firstAssistant = pendingAssistantParts.find((part) => part.kind === "assistant")
    entries.push({
      id: `assistant-turn-${first.id}-${last.id}`,
      kind: "assistantTurn",
      time: firstAssistant?.item.time ?? "",
      parts: pendingAssistantParts,
    })
    pendingAssistantParts = []
  }

  for (const item of items) {
    if (item.kind === "tool") {
      if (isPlanControlTool(item.title) || isGoalControlTool(item.title)) continue
      pendingTools.push(item)
      continue
    }
    if (item.kind === "user" && isInternalGoalPrompt(item.text)) {
      flushAssistantTurn()
      entries.push({ id: item.id, kind: "message", item: { ...item, text: safeSessionTitle(item.text) } })
      continue
    }
    if (item.kind === "assistant") {
      flushTools()
      if (item.text.trim()) pendingAssistantParts.push({ id: item.id, kind: "assistant", item })
      continue
    }
    flushAssistantTurn()
    entries.push({ id: item.id, kind: "message", item })
  }
  flushAssistantTurn()
  return entries
}

function isPlanControlTool(name: string) {
  return name === "plan_step_complete" || name === "plan_step_fail"
}

function isGoalControlTool(name: string) {
  return name === "goal_set_acceptance" || name === "goal_complete" || name === "goal_blocked"
}

function groupAssistantActivity(parts: AssistantTurnPart[]): AssistantRenderPart[] {
  const grouped: AssistantRenderPart[] = []
  let pendingActivity: AssistantTurnPart[] = []

  const flushActivity = () => {
    if (pendingActivity.length === 0) return
    const first = pendingActivity[0]
    grouped.push({ id: `activity-${first.id}`, kind: "activity", parts: pendingActivity })
    pendingActivity = []
  }

  for (const part of parts.flatMap(splitAssistantMessagePart)) {
    if (isAssistantActivityPart(part)) {
      pendingActivity.push(part)
      continue
    }
    flushActivity()
    grouped.push(part)
  }
  flushActivity()
  return grouped
}

function splitAssistantMessagePart(part: AssistantTurnPart): AssistantTurnPart[] {
  if (part.kind === "tools") return [part]
  const blocks = splitReasoningBlocks(part.item.text)
  if (blocks.length <= 1) return [part]
  return blocks.map((block, index) => {
    const text = block.kind === "reasoning" ? `<reasoning>${block.text}</reasoning>` : block.text
    return {
      id: `${part.id}-${block.kind}-${index}`,
      kind: "assistant",
      item: { ...part.item, id: `${part.item.id}-${block.kind}-${index}`, text },
    }
  })
}

function isAssistantActivityPart(part: AssistantTurnPart) {
  if (part.kind === "tools") return true
  return !splitReasoningBlocks(part.item.text).some((block) => block.kind === "markdown")
}

function SidebarGroup({ action, children, onAction, title }: { action?: string; children: React.ReactNode; onAction?: () => void; title: string }) {
  return <section className="sidebar-group"><div className="group-title"><span>{title}</span>{action && <button onClick={onAction}>{action}</button>}</div>{children}</section>
}

function planProgressSnapshot(planStatus: DesktopPlanStatusResult) {
  const plan = planStatus.plan?.plan
  const checkpoint = planStatus.plan?.checkpoint
  const steps = plan?.steps ?? []
  const stepStatuses = checkpoint?.stepStatuses ?? {}
  const currentIndex = steps.findIndex((step) => step.id === (planStatus.currentStepId ?? checkpoint?.currentStepId))
  const completed = Object.values(stepStatuses).filter((status) => status === "completed").length
  const current = currentIndex >= 0 ? steps[currentIndex] : undefined
  return {
    completed,
    current,
    currentIndex,
    status: planStatus.status ?? checkpoint?.status ?? "active",
    stepStatuses,
    steps,
    title: plan?.title ?? planStatus.planId ?? "Plan",
    total: steps.length,
  }
}

function EmptyState({ copy }: { copy: DesktopCopy }) {
  return <section className="empty-state"><h2>{copy.noMessages}</h2><p>{copy.startSession}</p></section>
}

function WorkspaceChangesBar({ copy, goal, onOpen, planStatus, status }: { copy: DesktopCopy; goal?: DesktopGoalState; onOpen: () => void; planStatus?: DesktopPlanStatusResult; status?: DesktopWorkspaceStatus }) {
  const plan = planStatus?.planId ? planProgressSnapshot(planStatus) : undefined
  if (!status && !plan && !goal) return null
  const changedStatus = status && !status.clean ? status : undefined
  const stepNumber = plan ? Math.max(1, Math.min(plan.total || 1, plan.currentIndex >= 0 ? plan.currentIndex + 1 : plan.completed || 1)) : 0
  return <div className="workspace-changes-bar">
    <button className={changedStatus ? "changed" : "clean"} onClick={onOpen} title={copy.showGitChanges}>
      {goal && <><span className="goal-inline-label">{copy.goal}</span><span className="goal-inline-objective">{goal.objective}</span><span className="status-separator">·</span></>}
      {plan && <><span className={`plan-inline-dot ${plan.status}`} /><span>{copy.stepProgress(stepNumber, plan.total || stepNumber)}</span><span className="status-separator">·</span></>}
      {status && <span>{status.clean ? copy.clean : copy.changedFiles(status.changedFiles)}</span>}
      {changedStatus && <><strong>+{changedStatus.added}</strong><em>-{changedStatus.deleted}</em></>}
    </button>
    {(goal || plan) && <div className="workspace-plan-popover">
      {goal && <div className="status-goal-summary">
        <strong>{goal.objective}</strong>
        <span>{copy.goalIteration(goal.status, goal.iteration)}</span>
      </div>}
      {plan ? plan.steps.map((step, index) => {
        const status = plan.stepStatuses[step.id] ?? "pending"
        return <div className={`status-plan-step ${status}`} key={step.id}>
          <span>{status === "completed" ? "✓" : index === plan.currentIndex ? "" : index + 1}</span>
          <p>{step.goal}</p>
        </div>
      }) : <div className="status-plan-step pending"><span>·</span><p>{copy.noActivePlan}</p></div>}
    </div>}
  </div>
}

function Message({ copy, item, onOpenFile }: { copy: DesktopCopy; item: Exclude<MessageItem, { kind: "assistant" }>; onOpenFile: MarkdownFileOpenHandler }) {
  if (item.kind === "status") return <article className="message status"><MarkdownText onOpenFile={onOpenFile} text={item.text} /></article>
  return <article className={`message ${item.kind}`}><div className="message-head"><strong>{item.kind === "user" ? copy.you : "EasyCode"}</strong><time>{item.time}</time></div><MessageText copy={copy} onOpenFile={onOpenFile} text={item.text || "..."} /></article>
}

function AssistantTurn({ copy, entry, onOpenFile }: { copy: DesktopCopy; entry: Extract<StreamEntry, { kind: "assistantTurn" }>; onOpenFile: MarkdownFileOpenHandler }) {
  const parts = groupAssistantActivity(entry.parts)
  const outputText = assistantOutputText(parts)
  return <article className="message assistant assistant-turn">
    <div className="message-head">
      <strong>EasyCode</strong>
      <div className="message-actions">
        {entry.time && <time>{entry.time}</time>}
        {outputText && <button className="copy-output" onClick={() => { void copyToClipboard(outputText) }} aria-label={copy.copyOutput} title={copy.copyOutput}><span className="copy-icon" /></button>}
      </div>
    </div>
    <div className="message-body">
      {parts.map((part) => part.kind === "activity"
        ? <ActivityGroup copy={copy} key={part.id} onOpenFile={onOpenFile} parts={part.parts} />
        : part.kind === "tools"
          ? <ToolGroup copy={copy} key={part.id} tools={part.tools} />
          : <MessageText copy={copy} key={part.id} onOpenFile={onOpenFile} text={part.item.text || "..."} />)}
    </div>
  </article>
}

function ActivityGroup({ copy, onOpenFile, parts }: { copy: DesktopCopy; onOpenFile: MarkdownFileOpenHandler; parts: AssistantTurnPart[] }) {
  const [open, setOpen] = useState(false)
  const reasoningCount = parts.reduce((count, part) => count + (part.kind === "assistant" ? reasoningBlockCount(part.item.text) : 0), 0)
  const toolCallCount = parts.reduce((count, part) => count + (part.kind === "tools" ? part.tools.length : 0), 0)
  const latest = activityLatestLabel(parts)
  const summary = activitySummary(copy, reasoningCount, toolCallCount)

  return <article className={`activity-group ${open ? "open" : ""}`}>
    <button className="activity-toggle" onClick={() => setOpen((value) => !value)}>
      <span className="status-dot green" />
      <strong>{copy.activity}</strong>
      <span>{summary}</span>
      <small>{latest}</small>
      <em>{open ? copy.hide : copy.show}</em>
    </button>
    {open && <div className="activity-list">
      {parts.map((part) => part.kind === "tools"
        ? <ToolGroup copy={copy} key={part.id} tools={part.tools} />
        : <MessageText copy={copy} key={part.id} onOpenFile={onOpenFile} text={part.item.text || "..."} />)}
    </div>}
  </article>
}

function MessageText({ copy, onOpenFile, text }: { copy: DesktopCopy; onOpenFile: MarkdownFileOpenHandler; text: string }) {
  return <div className="message-body">
    {splitReasoningBlocks(text).map((part, index) => part.kind === "reasoning"
      ? <ReasoningBlock copy={copy} key={`${part.kind}-${index}`} onOpenFile={onOpenFile} text={part.text} />
      : <MarkdownText key={`${part.kind}-${index}`} onOpenFile={onOpenFile} text={part.text} />)}
  </div>
}

function MarkdownText({ onOpenFile, text }: { onOpenFile: MarkdownFileOpenHandler; text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: (props) => <InlineCode {...props} onOpenFile={onOpenFile} /> }}>{text}</ReactMarkdown></div>
}

function InlineCode(props: { children?: React.ReactNode; className?: string; onOpenFile: MarkdownFileOpenHandler }) {
  const text = String(props.children ?? "").trim()
  const target = workspaceFileTarget(text)
  if (!props.className && target) {
    return <button className="file-link" onClick={() => {
      void props.onOpenFile(target)
    }}>{text}</button>
  }
  return <code className={props.className}>{props.children}</code>
}

function ReasoningBlock({ copy, onOpenFile, text }: { copy: DesktopCopy; onOpenFile: MarkdownFileOpenHandler; text: string }) {
  const [open, setOpen] = useState(false)
  return <section className={`reasoning-fold ${open ? "open" : ""}`}>
    <button onClick={() => setOpen((value) => !value)}>
      <span>{copy.reasoning}</span>
      <small>{open ? copy.hide : reasoningPreview(text)}</small>
    </button>
    {open && <MarkdownText onOpenFile={onOpenFile} text={text} />}
  </section>
}

function ToolGroup({ copy, tools }: { copy: DesktopCopy; tools: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const [openToolId, setOpenToolId] = useState<string>()
  const runningCount = tools.filter((tool) => tool.status === "running").length
  const status = runningCount > 0 ? copy.running : copy.completed
  const latest = tools[tools.length - 1]

  return <article className={`tool-group ${open ? "open" : ""}`}>
    <button className="tool-group-toggle" onClick={() => setOpen((value) => !value)}>
      <span className={`status-dot ${runningCount > 0 ? "blue" : "green"}`} />
      <strong>{copy.tools}</strong>
      <span>{copy.callCount(tools.length)}</span>
      <small>{latest?.title ?? status}</small>
      <em>{open ? copy.hide : status}</em>
    </button>
    {open && <div className="tool-list">
      {tools.map((tool) => {
        const detailOpen = openToolId === tool.id
        return <section className={`tool-entry ${detailOpen ? "open" : ""}`} key={tool.id}>
          <button onClick={() => setOpenToolId((id) => id === tool.id ? undefined : tool.id)}>
            <span className={`status-dot ${tool.status === "done" ? "green" : "blue"}`} />
            <span>{tool.title}</span>
            <small>{tool.status === "done" ? copy.completed : copy.running}</small>
          </button>
          {detailOpen && <pre>{tool.detail}</pre>}
        </section>
      })}
    </div>}
  </article>
}

function Composer({ attachments, copy, onCancelRun, onChangeEffort, onChangeModel, onClearAttachments, onPickFiles, onRemoveAttachment, permissionMode, prompt, providerReady, providerReadiness, queuedCount, runMode, running, sendPrompt, setPermissionMode, setPrompt, setRunMode, settings }: {
  attachments: Attachment[]
  copy: DesktopCopy
  onCancelRun: () => Promise<void>
  onChangeEffort: (effort: DesktopReasoningEffort) => void
  onChangeModel: (model: string) => void
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
  settings?: DesktopSettings
}) {
  const trimmedPrompt = prompt.trim()
  const isLocalSlash = trimmedPrompt.startsWith("/") && !trimmedPrompt.startsWith("//") && !isRunProducingSlashInput(trimmedPrompt)
  const blockedByProvider = !running && !providerReady && !isLocalSlash
  const provider = settings?.provider ?? "deepseek"
  const model = settings?.model ?? defaultSetupModel(provider)
  const effort = settings?.effort ?? "high"
  const permissionOptions: SelectOption[] = [
    { value: "ask", label: copy.ask },
    { value: "auto-review", label: copy.autoReview },
  ]
  return <footer className="composer">
    {attachments.length > 0 && <div className="attachments-wrap">
      <div className="attachments-head"><span>{copy.attachedCount(attachments.length)}</span><button onClick={() => { void onClearAttachments() }} disabled={running}>{copy.clearAll}</button></div>
      <div className="attachments">{attachments.map((file) => <button key={file.id} onClick={() => onRemoveAttachment(file.id)} disabled={running}><span>{file.name}</span><small>{file.kind} - {file.size}</small></button>)}</div>
    </div>}
    <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendPrompt()
    }} placeholder={copy.composerPlaceholder} />
    <div className="composer-bar">
      <button className="file-button" onClick={onPickFiles} disabled={running}>{copy.addFiles}</button>
      <div className="mode-toggle" role="group" aria-label="Run mode">
        <button className={runMode === "build" ? "selected" : ""} onClick={() => setRunMode("build")} disabled={running}>{copy.build}</button>
        <button className={runMode === "plan" ? "selected" : ""} onClick={() => setRunMode("plan")} disabled={running}>{copy.plan}</button>
        <button className={runMode === "goal" ? "selected" : ""} onClick={() => setRunMode("goal")} disabled={running}>{copy.goal}</button>
      </div>
      {runMode === "goal"
        ? <div className="permission-static" title={copy.goalRestrictedTitle}>{copy.goalRestricted}</div>
        : <ComposerDropdown className="permission-select" disabled={running} label={copy.permission} options={permissionOptions} value={permissionMode} onChange={(value) => setPermissionMode(value as PermissionMode)} />}
      <ComposerDropdown className="model-select" disabled={running} label={copy.model} options={modelSelectOptions(provider, model)} value={model} onChange={onChangeModel} />
      <ComposerDropdown className="effort-select" disabled={running} label={copy.effort} options={effortSelectOptions(copy)} value={effort} onChange={(value) => onChangeEffort(value as DesktopReasoningEffort)} />
      {blockedByProvider && <span className="composer-warning">{providerReadiness ? providerReadinessLabel(providerReadiness) : copy.providerNotReady}</span>}
      {queuedCount > 0 && <span className="queue-chip">{queuedInputLabel(queuedCount)}</span>}
      <button className={`send-button ${running ? "running" : ""}`} onClick={() => {
        if (running) void onCancelRun()
        else void sendPrompt()
      }} disabled={running ? false : !prompt.trim() || blockedByProvider} aria-label={running ? copy.cancel : copy.send}>
        {running ? <span className="stop-icon" aria-hidden="true" /> : <span className="send-icon" aria-hidden="true" />}
      </button>
    </div>
  </footer>
}

function ComposerDropdown({ className = "", disabled, label, onChange, options, value }: {
  className?: string
  disabled?: boolean
  label: string
  onChange: (value: string) => void
  options: SelectOption[]
  value: string
}) {
  const normalized = normalizeSelectOptions(options, value)
  const selected = normalized.find((option) => option.value === value) ?? normalized[0] ?? { value, label: value }
  return <div className={`composer-dropdown ${className}`}>
    <button className="composer-dropdown-trigger" type="button" disabled={disabled}>
      <span>{label}</span>
      <strong>{selected.label}</strong>
      <i aria-hidden="true" />
    </button>
    {!disabled && <div className="composer-dropdown-menu">
      {normalized.map((option) => <button className={option.value === value ? "selected" : ""} key={option.value} onClick={() => onChange(option.value)} type="button">
        <span>{option.label}</span>
        {option.value === value && <em>✓</em>}
      </button>)}
    </div>}
  </div>
}

function Panel({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="rail-panel"><div className="panel-title"><h2>{title}</h2></div>{children}</section>
}

function GitChangesPanel({ copy, status }: { copy: DesktopCopy; status?: DesktopWorkspaceStatus }) {
  const files = status?.files ?? []
  return <Panel title={copy.changes}>
    <InfoRow label={copy.gitBranch} value={status?.branch ?? "unknown"} detail={aheadBehind(status)} />
    <InfoRow label={copy.workingTree} value={status?.clean ? copy.clean : copy.modified} status={status?.clean ? "ok" : "warn"} />
    <div className="git-change-summary">
      <span>{status?.clean ? copy.clean : copy.changedFiles(status?.changedFiles ?? 0)}</span>
      {!status?.clean && <><strong>+{status?.added ?? 0}</strong><em>-{status?.deleted ?? 0}</em></>}
    </div>
    {status?.error && <div className="empty-list compact">{status.error}</div>}
    {!status?.error && files.length === 0 && <div className="empty-list compact">{status?.clean ? copy.clean : copy.noPathResolved}</div>}
    {files.length > 0 && <div className="git-change-list">
      {files.map((file) => <div className="git-change-row" key={`${file.status}-${file.path}`}>
        <span>{file.status}</span>
        <strong title={file.path}>{file.path}</strong>
        <small><b>+{file.added}</b><i>-{file.deleted}</i></small>
      </div>)}
    </div>}
  </Panel>
}

function SkillsPanel({ copy, onClear, onToggle, running, selected, skills }: { copy: DesktopCopy; onClear: () => void; onToggle: (skill: DesktopSkillInfo) => void; running: boolean; selected: string[]; skills: DesktopSkillInfo[] }) {
  const [expanded, setExpanded] = useState(false)
  const selectedSet = new Set(selected)
  const visible = expanded ? skills : skills.slice(0, 8)
  return <Panel title={copy.skills}>
    <div className="panel-inline-actions"><span>{copy.activeCount(selected.length)}</span><button onClick={onClear} disabled={running || selected.length === 0}>{copy.clearSkills}</button></div>
    {skills.length === 0 && <div className="empty-list compact">{copy.noSkillsFound}</div>}
    {visible.length > 0 && <div className="skill-list">
      {visible.map((skill) => {
        const active = selectedSet.has(skill.id) || selectedSet.has(skill.name)
        return <button key={skill.id} className={`skill-row ${active ? "active" : ""}`} onClick={() => onToggle(skill)} disabled={running}>
          <span>{active ? copy.on : copy.off}</span>
          <strong>{skill.name}</strong>
          <small>{skill.description}</small>
        </button>
      })}
    </div>}
    {skills.length > 8 && <button className="more-row" onClick={() => setExpanded((value) => !value)}>{expanded ? copy.showLess : copy.showAllSkills(skills.length)}</button>}
  </Panel>
}

function InfoRow({ detail, label, status, value }: { detail?: string; label: string; status?: "ok" | "warn"; value: string }) {
  return <div className="info-row"><div><span>{label}</span>{detail && <small>{detail}</small>}</div><strong className={status}>{value}</strong></div>
}

function SelectRow({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: Array<string | SelectOption>; value: string }) {
  const normalized = normalizeSelectOptions(options, value)
  const selected = normalized.find((option) => option.value === value) ?? normalized[0] ?? { value, label: value }
  return <div className="editable-row"><span>{label}</span><div className="panel-dropdown">
    <button className="panel-dropdown-trigger" type="button">
      <strong>{selected.label}</strong>
      <i aria-hidden="true" />
    </button>
    <div className="panel-dropdown-menu">
      {normalized.map((option) => <button className={option.value === value ? "selected" : ""} key={option.value} onClick={() => onChange(option.value)} type="button">
        <span>{option.label}</span>
        {option.value === value && <em>✓</em>}
      </button>)}
    </div>
  </div></div>
}

function ToggleRow({ copy, label, onChange, value }: { copy: DesktopCopy; label: string; onChange: (value: boolean) => void; value: boolean }) {
  return <div className="editable-row"><span>{label}</span><button className={`toggle-button ${value ? "on" : ""}`} onClick={() => onChange(!value)}>{value ? copy.on : copy.off}</button></div>
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
  const [model, setModel] = useState(settings.model ?? defaultSetupModel(provider))
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
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {modelSelectOptions(provider, model).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
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
      await window.easycode.replyPermission(prompt.requestId, sidecarPermissionReply(action), prompt.workspaceRoot)
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
      await window.easycode.replyPlan(prompt.runId, payload.action, payload.text, prompt.workspaceRoot)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      onError(error, "Plan reply failed.")
    } finally {
      setSubmitting(false)
    }
  }
  return <div className="modal"><section><h2>Approve plan</h2><div className="plan-preview"><MarkdownText onOpenFile={noopOpenFile} text={displayPlanMarkdown(prompt.markdown)} /></div><textarea className="plan-reply" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Describe plan changes, or enter a new prompt." />{error && <p className="setup-error">{error}</p>}<div className="modal-actions"><button onClick={() => reply("reject")} className="secondary" disabled={submitting}>Reject</button><button onClick={() => reply("new_prompt")} className="secondary" disabled={!hasDraft || submitting}>New prompt</button><button onClick={() => reply("edit")} className="secondary" disabled={!hasDraft || submitting}>Edit plan</button><button onClick={() => reply("approve")} disabled={submitting}>Approve</button></div></section></div>
}

function currentTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function displayRunStatus(status: RunStatus) {
  if (status === "waiting_plan") return "Waiting for plan"
  if (status === "waiting_permission") return "Waiting for permission"
  if (status === "blocked") return "Blocked"
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

function normalizeSelectOptions(options: Array<string | SelectOption>, value: string) {
  const normalized = options.map((option) => typeof option === "string" ? { value: option, label: option } : option).filter((option) => option.value)
  if (value && !normalized.some((option) => option.value === value)) return [{ value, label: value }, ...normalized]
  return normalized
}

function languageSelectOptions(copy: DesktopCopy): SelectOption[] {
  const languages = ["en", "zh", "ja", "fr", "ko", "de"]
  return languages.map((value) => ({ value, label: copy.languageName(value) }))
}

function effortSelectOptions(copy: DesktopCopy): SelectOption[] {
  return [
    { value: "low", label: copy.effortLow },
    { value: "medium", label: copy.effortMedium },
    { value: "high", label: copy.effortHigh },
    { value: "max", label: copy.effortMax },
  ]
}

function modelSelectOptions(provider: string, selected?: string): SelectOption[] {
  return normalizeSelectOptions(providerModelOptions(provider), selected ?? defaultSetupModel(provider))
}

function providerModelOptions(provider: string) {
  if (provider === "openai") return ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]
  if (provider === "openai-compatible") return ["openai-compatible"]
  return ["deepseek-v4-pro", "deepseek-v4-flash"]
}

function defaultSetupModel(provider: string) {
  return providerModelOptions(provider)[0] ?? "deepseek-v4-pro"
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

function workspaceDisplayName(root: string) {
  return root.split(/[\\/]/).filter(Boolean).at(-1) || root
}

function sessionTitle(session: DesktopSessionSummary) {
  return truncateSessionTitle(safeSessionTitle(session.title || session.id))
}

function fullSessionTitle(session: DesktopSessionSummary) {
  return safeSessionTitle(session.title || session.id)
}

function firstDisplayUserTitle(items: ChatItem[]) {
  for (const item of items) {
    if (item.kind !== "user") continue
    if (isInternalGoalPrompt(item.text)) continue
    const text = item.text.replace(/\s+/g, " ").trim()
    if (text) return text
  }
  return undefined
}

function isInternalGoalPrompt(text: string) {
  return Boolean(internalGoalObjective(text))
}

function internalGoalObjective(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact.startsWith("Goal objective:")) return undefined
  const match = compact.match(/^Goal objective:\s*(.*?)\s+Goal iteration:\s*\d+\s+Definition reason:/i)
  if (match?.[1]) return match[1].trim()
  const fallback = compact.slice("Goal objective:".length).split("Goal iteration:")[0]?.trim()
  return fallback || undefined
}

function safeSessionTitle(title: string) {
  const text = title.replace(/\s+/g, " ").trim()
  if (!isInternalGoalPrompt(text)) return text
  return internalGoalObjective(text) || "Goal"
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

function reasoningBlockCount(text: string) {
  return splitReasoningBlocks(text).filter((part) => part.kind === "reasoning").length
}

function activitySummary(copy: DesktopCopy, reasoningCount: number, toolCallCount: number) {
  const parts = []
  if (reasoningCount > 0) parts.push(copy.reasoningCount(reasoningCount))
  if (toolCallCount > 0) parts.push(copy.toolCallCount(toolCallCount))
  return parts.join(" · ") || copy.details
}

function activityLatestLabel(parts: AssistantTurnPart[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.kind === "tools") return part.tools[part.tools.length - 1]?.title ?? "tools"
    const preview = reasoningPreview(part.item.text)
    if (preview) return preview
  }
  return "details"
}

function assistantOutputText(parts: AssistantRenderPart[]) {
  return parts.flatMap((part) => {
    if (part.kind === "activity" || part.kind === "tools") return []
    return splitReasoningBlocks(part.item.text)
      .filter((block) => block.kind === "markdown")
      .map((block) => block.text.trim())
      .filter(Boolean)
  }).join("\n\n").trim()
}

async function copyToClipboard(text: string) {
  const value = text.trim()
  if (!value) return
  await navigator.clipboard.writeText(value)
}

function workspaceFileTarget(text: string) {
  const clean = text.trim().replace(/^["']|["']$/g, "")
  if (!clean || clean.includes("\n") || clean.includes("://") || clean.startsWith("~")) return undefined
  if (pathLooksUnsafe(clean)) return undefined
  return /\.[A-Za-z0-9]{1,8}$/.test(clean) ? clean : undefined
}

function pathLooksUnsafe(text: string) {
  return text.startsWith("/") || text.split(/[\\/]/).some((part) => part === "..")
}

function messagesToItems(messages: DesktopMessage[]): ChatItem[] {
  return messages.flatMap((message): ChatItem[] => {
    if (message.role === "tool") return message.parts.flatMap((part) => toolPartToItem(message, part))
    if (message.role !== "user" && message.role !== "assistant") return []
    const text = message.parts.map(partToText).filter(Boolean).join("\n")
    if (message.role === "assistant" && isSettingsStatusMessage(text)) return []
    const displayText = message.role === "user" && isInternalGoalPrompt(text) ? safeSessionTitle(text) : text
    return [{
      id: message.id,
      kind: message.role,
      text: displayText,
      time: new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }]
  })
}

function isSettingsStatusMessage(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  return /^(语言|Language)\s+/.test(compact)
    || /^(模型|Model)\s+/.test(compact)
    || /^(思考|Thinking)\s+/.test(compact)
    || /^(推理强度|Effort)\s+/.test(compact)
    || /^(Provider|提供商)\s+/.test(compact)
    || /^(最大 Token|Max Tokens|最大步数|Max Steps)\s+/.test(compact)
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
