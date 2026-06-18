export const uiLanguages = ["en", "zh", "ja", "fr", "ko", "de"] as const

export type UiLanguage = (typeof uiLanguages)[number]

export type SlashErrorCode =
  | "image_requires_value"
  | "skill_remove_requires_name"
  | "skill_use_requires_name"
  | "plan_requires_objective"
  | "model_requires_name"
  | "provider_requires_name"
  | "effort_requires_value"
  | "session_switch_requires_name"
  | "session_delete_requires_name"
  | "thinking_requires_value"

export type UiCopy = {
  helpTitle: string
  helpText: string
  webSearchTitle: string
  webSearchNotConfigured: string
  sessionTitle: string
  sessionsTitle: string
  settingsTitle: string
  commandTitle: string
  modelTitle: string
  providerTitle: string
  thinkingTitle: string
  effortTitle: string
  imageTitle: string
  skillsTitle: string
  languageTitle: string
  startingNewSession: (name: string) => string
  selectSession: string
  selectSessionHint: string
  selectSessionRange: (count: number) => string
  savedSessions: string
  noSavedSessions: string
  noSessionStore: string
  sessionSummary: (index: number, id: string, current: boolean, count: number) => string
  sessionSwitchCurrent: (id: string) => string
  sessionSwitched: (id: string) => string
  sessionDeleted: (id: string, memoryId: string) => string
  sessionDeletedAndSwitched: (id: string, next: string, memoryId: string) => string
  sessionNotFound: (id: string) => string
  commandUnknown: (name: string) => string
  slashError: (code: SlashErrorCode) => string
  modelSet: (model: string) => string
  providerUnknown: (provider: string, available: string) => string
  providerSet: (provider: string) => string
  providerThinkingUnsupported: (provider: string) => string
  thinkingUpdated: (enabled: boolean, aliasUsed: boolean) => string
  providerEffortUnsupported: (provider: string) => string
  effortUpdated: (value: string, thinking: boolean) => string
  pendingImagesCleared: string
  providerImageUnsupported: (provider: string) => string
  imageAttached: (label: string) => string
  noSkillsFound: string
  skillsCleared: string
  skillNotFound: (name: string) => string
  skillActivated: (id: string) => string
  noActiveSkillFound: (name: string) => string
  skillRemoved: (ids: string) => string
  languageCurrent: (current: string, options: string) => string
  languageInvalid: (value: string, options: string) => string
  languageUpdated: (value: string, envPath: string) => string
  settingsText: (input: { provider: string; model?: string; thinking: boolean; effort: string; language: string; skills: string; pendingSkillLoads: string; pendingImages: number; maxTokens?: number; maxSteps?: number }) => string
  runInputHint: string
  queuedNextInput: (text: string) => string
  cancellingRun: string
  cancelledRun: string
  permissionTitle: string
  planApprovalPrompt: string
  planAutoApproved: string
  promptChangedQuestion: string
  tuiConfiguredTitle: string
  tuiConfiguredLine: (provider: string, model: string, mode: string, status: string, language: string) => string
  sessionStartedTitle: string
  activeSession: (session: string) => string
  inputPrompt: string
  sessionPrompt: string
  liveMonitorTitle: string
  statusLabel: string
  elapsedLabel: string
  queuedNextLabel: string
  metricsLabel: string
  goalPanelSummary: (status: string, iteration: number, activePlanId?: string) => string
  goalPanelDetail: (objective: string, blocker?: string) => string
  goalModeTitle: string
  goalStepStats: (step: number, total: number) => string
  goalFilesChanged: (files: number) => string
  typeCancelHint: string
  welcomeTitle: string
  welcomeOverview: (mode: string, provider: string, model: string) => string
  welcomeSession: (session: string, logger: string, status: string, language: string) => string
  welcomeRoot: (root: string) => string
  welcomeCommands: string
  welcomeProjectRoot: string
  welcomeAgent: string
  welcomeRunMode: string
  welcomeSessionId: string
  welcomeSlashCommands: string
  welcomeCommandLines: string[]
  successTitle: string
  failureTitle: string
  successStatus: string
  failureStatus: string
  durationLine: (duration: string) => string
  reasonLine: (reason: string) => string
  roundCallsLine: (value: string) => string
  roundTokensLine: (value: string, hitRate?: string) => string
  roundSubagentInvocationsLine: (value: string) => string
  roundSubagentDetailLine: (value: string) => string
  roundSubagentCallsLine: (value: string) => string
  roundSubagentTokensLine: (value: string) => string
  sessionCallsLine: (value: string) => string
  sessionTokensLine: (value: string, input: string, output: string) => string
  sessionSubagentCallsLine: (value: string) => string
  sessionSubagentTokensLine: (value: string, input: string, output: string) => string
  statusReady: string
  statusSessionSelected: string
  statusInitializing: string
  statusThinking: string
  statusAnswering: string
  statusWaitingProvider: (provider: string) => string
  statusExecutingTool: (name: string) => string
  statusRunningTool: (name: string, elapsed: string) => string
  statusToolCompleted: (name: string) => string
  statusCompacting: string
  statusCompactionDone: (status: string) => string
  statusRepoMap: (status: string) => string
  statusProviderMetrics: string
  statusFailed: string
  statusRunning: string
  statusApproved: string
  statusInputMonitor: string
  statusQueuedInput: string
  statusCancelling: string
  statusPlanApproval: string
  timelineModel: string
  timelineWaitingFor: (provider: string, elapsed: string) => string
  timelineMetrics: string
  timelineSubagentScheduled: (summary: string) => string
  timelineSubagentCompleted: (role: string, elapsed: string, metrics: string) => string
  timelineSubagentFailed: (role: string, elapsed: string, error: string) => string
  timelineContextCompactionStart: (count: string) => string
  timelineContextCompactionDone: (elapsed: string, summary: string, tokens: string) => string
  timelineContextCompactionFailed: (elapsed: string, error: string) => string
  timelineRepoMapSuccess: (cache: string, files: number, relevant: string, cachePath: string) => string
  timelineRepoMapFailed: (error: string) => string
  timelineThought: string
  timelineThoughtDone: (elapsed: number) => string
  timelineAnswer: string
  timelineToolRunning: (tool: string, elapsed: string) => string
  timelineGoalLifecycle: (phase: string, status: string, objective: string, iteration: number, activePlanId?: string, blocker?: string) => string
  timelineMetricsBody: (input: {
    provider: string
    model: string
    calls: number
    latency: string
    ttft: string
    speed: string
    inputTokens: string
    cached: string
    miss: string
    hitRate: string
    outputTokens: string
    reasoning: string
    total: string
    effectiveCost: string
    cacheHitRate: string
    cacheMissRate: string
    outputRate: string
  }) => string[]
}
