export const uiLanguages = ["en", "zh", "ja", "fr", "ko", "de"] as const

export type UiLanguage = (typeof uiLanguages)[number]

const languageLabels: Record<UiLanguage, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
  fr: "Français",
  ko: "한국어",
  de: "Deutsch",
}

const localeMap: Record<UiLanguage, string> = {
  en: "en-US",
  zh: "zh-CN",
  ja: "ja-JP",
  fr: "fr-FR",
  ko: "ko-KR",
  de: "de-DE",
}

const aliases: Record<string, UiLanguage> = {
  en: "en",
  english: "en",
  zh: "zh",
  "zh-cn": "zh",
  "zh-hans": "zh",
  cn: "zh",
  chinese: "zh",
  "中文": "zh",
  ja: "ja",
  jp: "ja",
  japanese: "ja",
  "日本語": "ja",
  fr: "fr",
  french: "fr",
  francais: "fr",
  "français": "fr",
  ko: "ko",
  kr: "ko",
  korean: "ko",
  "한국어": "ko",
  de: "de",
  german: "de",
  deutsch: "de",
}

export type SlashErrorCode =
  | "image_requires_value"
  | "skill_remove_requires_name"
  | "skill_use_requires_name"
  | "model_requires_name"
  | "provider_requires_name"
  | "effort_requires_value"
  | "session_switch_requires_name"
  | "session_delete_requires_name"
  | "thinking_requires_value"

export function languageLabel(language: UiLanguage) {
  return languageLabels[language]
}

export function languageLocale(language: UiLanguage) {
  return localeMap[language]
}

export function supportedLanguageSummary() {
  return uiLanguages.map((language) => `${language} (${languageLabel(language)})`).join(", ")
}

export function normalizeUiLanguage(value: string | undefined | null, fallback: UiLanguage = "en"): UiLanguage {
  if (!value) return fallback
  const normalized = aliases[value.trim().toLowerCase()]
  return normalized ?? fallback
}

export function parseUiLanguage(value: string | undefined | null) {
  if (!value) return undefined
  return aliases[value.trim().toLowerCase()]
}

export function detectUiLanguage(env: Record<string, string | undefined> = process.env): UiLanguage {
  const configured = parseUiLanguage(env.EASYCODE_LANG)
  if (configured) return configured
  const locale = (env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase()
  if (locale.startsWith("zh")) return "zh"
  if (locale.startsWith("ja")) return "ja"
  if (locale.startsWith("fr")) return "fr"
  if (locale.startsWith("ko")) return "ko"
  if (locale.startsWith("de")) return "de"
  return "en"
}

function formatLanguageChoices() {
  return uiLanguages.map((language) => `${language} (${languageLabel(language)})`).join(", ")
}

type UiCopy = {
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

function buildEnglishCopy(): UiCopy {
  const goalStatusName = (status: string) => ({
    defining: "defining",
    planning: "planning",
    executing: "executing",
    reviewing: "reviewing",
    paused: "paused",
    blocked: "blocked",
    completed: "completed",
  })[status] ?? status
  const goalPhaseName = (phase: string) => ({
    started: "started",
    definition: "definition",
    planning: "planning",
    executing: "executing",
    reviewing: "reviewing",
    paused: "paused",
    blocked: "blocked",
    completed: "completed",
    cleared: "cleared",
  })[phase] ?? phase
  return {
    helpTitle: "Help",
    helpText: [
      "Commands:",
      "  /image <path-or-url>    attach an image to the next prompt",
      "  /image clear            clear pending images",
      "  /skill list             list available skills",
      "  /skill use <name>       keep a skill active for this session",
      "  /skill remove <name>    remove one active skill",
      "  /skill clear            clear active skills",
      "  /model <name>           switch model (e.g. gpt-5.5)",
      "  /provider <name>        switch provider (e.g. openai)",
      "  /effort <level>         set thinking strength: low, medium, high, max",
      "  /thinking on|off        enable or disable model thinking",
      "  /lang <code>            set UI language: en, zh, ja, fr, ko, de",
      "  /settings               show current session settings",
      "  /goal <objective>       start or replace the active goal",
      "  /goal status            show the active goal state",
      "  /goal pause|resume      pause or resume automatic goal continuation",
      "  /goal clear             clear the active goal",
      "  /sessions               list saved sessions",
      "  /session switch <id>    switch to another session",
      "  /session delete <id>    archive and delete a session",
      "  //text                  send /text as a normal prompt",
    ].join("\n"),
    webSearchTitle: "Web Search",
    webSearchNotConfigured: "Live web search is not configured.",
    sessionTitle: "Session",
    sessionsTitle: "Sessions",
    settingsTitle: "Settings",
    commandTitle: "Command",
    modelTitle: "Model",
    providerTitle: "Provider",
    thinkingTitle: "Thinking",
    effortTitle: "Effort",
    imageTitle: "Image",
    skillsTitle: "Skills",
    languageTitle: "Language",
    startingNewSession: (name) => `Starting new session: ${name}`,
    selectSession: "Select a session:",
    selectSessionHint: "Press Enter for 1, enter a number, or type a new session id.",
    selectSessionRange: (count) => `Choose 1-${count}, or type a non-numeric new session id.`,
    savedSessions: "Saved sessions:",
    noSavedSessions: "No saved sessions.",
    noSessionStore: "No session store is active.",
    sessionSummary: (index, id, current, count) => `  ${index}. ${id}${current ? " (current)" : ""} - ${count} ${count === 1 ? "message" : "messages"}`,
    sessionSwitchCurrent: (id) => `Already using session: ${id}`,
    sessionSwitched: (id) => `Switched to session: ${id}`,
    sessionDeleted: (id, memoryId) => `Deleted session: ${id}. Archived summary to project memory (${memoryId}).`,
    sessionDeletedAndSwitched: (id, next, memoryId) => `Deleted session: ${id}. Switched to ${next}. Archived summary to project memory (${memoryId}).`,
    sessionNotFound: (id) => `Session not found: ${id}`,
    commandUnknown: (name) => `Unknown command: /${name}. Use /help.`,
    slashError: (code) => ({
      image_requires_value: "/image requires a path or URL",
      skill_remove_requires_name: "/skill remove requires a skill name",
      skill_use_requires_name: "/skill use requires a skill name",
      model_requires_name: "/model requires a model name",
      provider_requires_name: "/provider requires a provider name",
      effort_requires_value: "/effort requires low, medium, high, or max",
      session_switch_requires_name: "/session switch requires a session id",
      session_delete_requires_name: "/session delete requires a session id",
      thinking_requires_value: "/thinking requires on or off",
    })[code],
    modelSet: (model) => `Model set to ${model}`,
    providerUnknown: (provider, available) => `Unknown provider: ${provider}. Available providers: ${available}`,
    providerSet: (provider) => `Provider set to ${provider}`,
    providerThinkingUnsupported: (provider) => `Provider ${provider} does not support thinking controls.`,
    thinkingUpdated: (enabled, aliasUsed) => `${aliasUsed ? "Alias /thingking accepted; use /thinking next time. " : ""}Thinking ${enabled ? "on" : "off"}.`,
    providerEffortUnsupported: (provider) => `Provider ${provider} does not support effort controls.`,
    effortUpdated: (value, thinking) => `Effort set to ${value}${thinking ? "" : " (applies when /thinking is on)"}.`,
    pendingImagesCleared: "Pending images cleared.",
    providerImageUnsupported: (provider) => `Provider ${provider} does not support image input. Use /model openai with a vision-capable model.`,
    imageAttached: (label) => `Attached image: ${label}`,
    noSkillsFound: "No skills found.",
    skillsCleared: "Active skills cleared.",
    skillNotFound: (name) => `Skill not found: ${name}`,
    skillActivated: (id) => `Skill active: ${id}`,
    noActiveSkillFound: (name) => `No active skill found: ${name}`,
    skillRemoved: (ids) => `Skill removed: ${ids}`,
    languageCurrent: (current, options) => `Current UI language: ${current}\nAvailable: ${options}`,
    languageInvalid: (value, options) => `Unsupported language: ${value}. Available: ${options}`,
    languageUpdated: (value, envPath) => `UI language set to ${value}. Saved to ${envPath}`,
    settingsText: ({ provider, model, thinking, effort, language, skills, pendingSkillLoads, pendingImages, maxTokens, maxSteps }) => [
      `provider: ${provider}`,
      `model: ${model ?? "(provider default)"}`,
      `thinking: ${thinking ? "on" : "off"}`,
      `effort: ${effort}`,
      `language: ${language}`,
      "cache: enabled",
      `maxTokens: ${maxTokens}`,
      `maxSteps: ${maxSteps}`,
      `skills: ${skills}`,
      `pendingSkillLoads: ${pendingSkillLoads}`,
      `pending images: ${pendingImages}`,
    ].join("\n"),
    runInputHint: "Type /cancel to stop this run; other input is queued for the next run.",
    queuedNextInput: (text) => `Queued next input: ${text}`,
    cancellingRun: "Cancelling current run...",
    cancelledRun: "Cancelling current run...",
    permissionTitle: "Permission Required",
    planApprovalPrompt: "[Plan] [A]pprove & execute  [R]eject  [E]dit plan  [N]ew prompt [A]: ",
    planAutoApproved: "Low-risk plan detected. Auto-approving and executing...",
    promptChangedQuestion: "What would you like changed? ",
    tuiConfiguredTitle: "TUI Configured",
    tuiConfiguredLine: (provider, model, mode, status, language) => `provider: ${provider}  ·  model: ${model}  ·  mode: ${mode}  ·  language: ${language}  ·  status: ${status}`,
    sessionStartedTitle: "Session Started",
    activeSession: (session) => `Active Session: ${session}`,
    inputPrompt: "easycode> ",
    sessionPrompt: "session> ",
    liveMonitorTitle: "EasyCode Live Monitor",
    statusLabel: "Status",
    elapsedLabel: "Elapsed",
    queuedNextLabel: "Queued Next",
    metricsLabel: "Metrics",
    goalPanelSummary: (status, iteration, activePlanId) => `Goal: ${goalStatusName(status)}  ·  iter: ${iteration}  ·  plan: ${activePlanId ?? "none"}`,
    goalPanelDetail: (objective, blocker) => blocker ? `Objective: ${objective}  ·  blocker: ${blocker}` : `Objective: ${objective}`,
    typeCancelHint: "Type /cancel to stop execution",
    welcomeTitle: "EasyCode TUI",
    welcomeOverview: (mode, provider, model) => `EasyCode TUI | mode=${mode} provider=${provider} model=${model}`,
    welcomeSession: (session, logger, status, language) => `session=${session} logger=${logger} language=${language} status=${status}`,
    welcomeRoot: (root) => `root=${root}`,
    welcomeCommands: "/help /settings /goal /sessions /session /model /skill /image /thinking /effort /lang /cancel",
    welcomeProjectRoot: "Project Root:",
    welcomeAgent: "AI Agent:",
    welcomeRunMode: "Run Mode:",
    welcomeSessionId: "Session ID:",
    welcomeSlashCommands: "Slash Commands:",
    welcomeCommandLines: [
      "   /help      Show help details      /settings  View active settings",
      "   /goal      Manage one active goal /sessions  List saved sessions",
      "   /session   Switch or delete sessions",
      "   /model     Change active model    /skill     Manage skills",
      "   /image     Attach vision input    /lang      Change UI language",
      "   /cancel    Stop active execution",
    ],
    successTitle: "Execution Completed",
    failureTitle: "Execution Failed",
    successStatus: "SUCCESS",
    failureStatus: "FAILED",
    durationLine: (duration) => `Duration: ${duration}`,
    reasonLine: (reason) => `Reason: ${reason}`,
    roundCallsLine: (value) => `Round Calls: ${value}`,
    roundTokensLine: (value, hitRate) => `Round Tokens: ${value}${hitRate ? ` (cache hit: ${hitRate})` : ""}`,
    roundSubagentInvocationsLine: (value) => `Round Subagent Invocations: ${value}`,
    roundSubagentDetailLine: (value) => `Round Subagent Detail: ${value}`,
    roundSubagentCallsLine: (value) => `Round Subagent Turns: ${value}`,
    roundSubagentTokensLine: (value) => `Round Subagent Tokens: ${value}`,
    sessionCallsLine: (value) => `Session Calls: ${value}`,
    sessionTokensLine: (value, input, output) => `Session Tokens: ${value} (in: ${input}, out: ${output})`,
    sessionSubagentCallsLine: (value) => `Session Subagent Turns: ${value}`,
    sessionSubagentTokensLine: (value, input, output) => `Session Subagent Tokens: ${value} (in: ${input}, out: ${output})`,
    statusReady: "ready",
    statusSessionSelected: "session selected",
    statusInitializing: "Initializing run...",
    statusThinking: "Model thinking...",
    statusAnswering: "Model answering...",
    statusWaitingProvider: (provider) => `Waiting for ${provider}...`,
    statusExecutingTool: (name) => `Executing tool: ${name}`,
    statusRunningTool: (name, elapsed) => `Running tool: ${name} (${elapsed})`,
    statusToolCompleted: (name) => `Tool completed: ${name}`,
    statusCompacting: "Compacting context...",
    statusCompactionDone: (status) => `Context compaction ${status}`,
    statusRepoMap: (status) => `Prewarming repo map (${status})`,
    statusProviderMetrics: "Received provider metrics",
    statusFailed: "failed",
    statusRunning: "running",
    statusApproved: "approved",
    statusInputMonitor: "input monitor",
    statusQueuedInput: "queued input",
    statusCancelling: "cancelling",
    statusPlanApproval: "plan approval",
    timelineModel: "● Model",
    timelineWaitingFor: (provider, elapsed) => `  … waiting for ${provider} after ${elapsed}\n`,
    timelineMetrics: "● Metrics",
    timelineSubagentScheduled: (summary) => `● Subagent scheduled ${summary}`,
    timelineSubagentCompleted: (role, elapsed, metrics) => `  ✓ Subagent ${role} completed${elapsed}${metrics}\n`,
    timelineSubagentFailed: (role, elapsed, error) => `  × Subagent ${role} failed${elapsed}${error}\n`,
    timelineContextCompactionStart: (count) => `● Context compaction summarizing older context${count}`,
    timelineContextCompactionDone: (elapsed, summary, tokens) => `  ✓ Context compacted${elapsed}${summary}${tokens}\n`,
    timelineContextCompactionFailed: (elapsed, error) => `  × Context compaction failed${elapsed}${error}\n`,
    timelineRepoMapSuccess: (cache, files, relevant, cachePath) => `● repo_map prewarm ${cache}, files=${files}${relevant}, path=${cachePath}`,
    timelineRepoMapFailed: (error) => `● repo_map prewarm failed${error}`,
    timelineThought: "● Thought",
    timelineThoughtDone: (elapsed) => `  Thought for ${elapsed}s\n`,
    timelineAnswer: "● Answer",
    timelineToolRunning: (tool, elapsed) => `  … ${tool} still running after ${elapsed}\n`,
    timelineGoalLifecycle: (phase, status, objective, iteration, activePlanId, blocker) => `● Goal ${goalPhaseName(phase)} status=${goalStatusName(status)}, iteration=${iteration}, objective=${JSON.stringify(objective)}, plan=${activePlanId ?? "none"}${blocker ? `, blocker=${JSON.stringify(blocker)}` : ""}`,
    timelineMetricsBody: ({ provider, model, calls, latency, ttft, speed, inputTokens, cached, miss, hitRate, outputTokens, reasoning, total, effectiveCost, cacheHitRate, cacheMissRate, outputRate }) => [
      `  provider ${provider}${model} · calls=${calls} · latency=${latency} · ttft=${ttft} · output_rate=${speed}`,
      `  usage input=${inputTokens} cached=${cached} miss=${miss} hit_rate=${hitRate} output=${outputTokens}${reasoning}${total}`,
      `  cost effective=${effectiveCost} per_1M(cache_hit=${cacheHitRate} cache_miss=${cacheMissRate} output=${outputRate})`,
    ],
  }
}

function cloneWith(base: UiCopy, overrides: Partial<UiCopy>): UiCopy {
  return { ...base, ...overrides }
}

const english = buildEnglishCopy()

const copies: Record<UiLanguage, UiCopy> = {
  en: english,
  zh: cloneWith(english, {
    helpTitle: "帮助",
    webSearchTitle: "联网搜索",
    webSearchNotConfigured: "尚未配置实时联网搜索。",
    sessionTitle: "会话",
    sessionsTitle: "会话列表",
    settingsTitle: "设置",
    commandTitle: "命令",
    modelTitle: "模型",
    providerTitle: "Provider",
    thinkingTitle: "思考",
    effortTitle: "强度",
    imageTitle: "图片",
    skillsTitle: "技能",
    languageTitle: "语言",
    helpText: [
      "命令：",
      "  /image <path-or-url>    给下一条提问附加图片",
      "  /image clear            清空待发送图片",
      "  /skill list             列出可用技能",
      "  /skill use <name>       在当前会话启用技能",
      "  /skill remove <name>    移除一个已启用技能",
      "  /skill clear            清空已启用技能",
      "  /model <name>           切换模型",
      "  /provider <name>        切换 provider",
      "  /effort <level>         设置思考强度：low、medium、high、max",
      "  /thinking on|off        开启或关闭思考",
      "  /lang <code>            设置界面语言：en、zh、ja、fr、ko、de",
      "  /settings               查看当前会话设置",
      "  /goal <objective>       启动或替换当前 goal",
      "  /goal status            查看当前 goal 状态",
      "  /goal pause|resume      暂停或恢复 goal 自动续跑",
      "  /goal clear             清空当前 goal",
      "  /sessions               查看保存的会话",
      "  /session switch <id>    切换到其他会话",
      "  /session delete <id>    归档并删除一个会话",
      "  //text                  把 /text 当普通提示词发送",
    ].join("\n"),
    startingNewSession: (name) => `开始新会话：${name}`,
    selectSession: "请选择会话：",
    selectSessionHint: "直接回车选 1，输入数字选择，或输入新的会话 id。",
    selectSessionRange: (count) => `请输入 1-${count}，或输入非数字的新会话 id。`,
    savedSessions: "已保存会话：",
    noSavedSessions: "没有已保存会话。",
    noSessionStore: "当前未启用会话存储。",
    sessionSummary: (index, id, current, count) => `  ${index}. ${id}${current ? "（当前）" : ""} - ${count} 条消息`,
    sessionSwitchCurrent: (id) => `当前已经在使用会话：${id}`,
    sessionSwitched: (id) => `已切换到会话：${id}`,
    sessionDeleted: (id, memoryId) => `已删除会话：${id}。摘要已归档到项目长期记忆（${memoryId}）。`,
    sessionDeletedAndSwitched: (id, next, memoryId) => `已删除会话：${id}，并切换到 ${next}。摘要已归档到项目长期记忆（${memoryId}）。`,
    sessionNotFound: (id) => `未找到会话：${id}`,
    commandUnknown: (name) => `未知命令：/${name}。请使用 /help。`,
    slashError: (code) => ({
      image_requires_value: "/image 需要路径或 URL",
      skill_remove_requires_name: "/skill remove 需要技能名",
      skill_use_requires_name: "/skill use 需要技能名",
      model_requires_name: "/model 需要模型名",
      provider_requires_name: "/provider 需要 provider 名",
      effort_requires_value: "/effort 需要 low、medium、high 或 max",
      session_switch_requires_name: "/session switch 需要会话 id",
      session_delete_requires_name: "/session delete 需要会话 id",
      thinking_requires_value: "/thinking 需要 on 或 off",
    })[code],
    modelSet: (model) => `模型已切换为 ${model}`,
    providerUnknown: (provider, available) => `未知 provider：${provider}。可用项：${available}`,
    providerSet: (provider) => `Provider 已切换为 ${provider}`,
    providerThinkingUnsupported: (provider) => `Provider ${provider} 不支持思考开关。`,
    thinkingUpdated: (enabled, aliasUsed) => `${aliasUsed ? "已接受 /thingking 别名；下次请使用 /thinking。 " : ""}思考已${enabled ? "开启" : "关闭"}。`,
    providerEffortUnsupported: (provider) => `Provider ${provider} 不支持思考强度设置。`,
    effortUpdated: (value, thinking) => `思考强度已设为 ${value}${thinking ? "" : "（在 /thinking 开启后生效）"}。`,
    pendingImagesCleared: "待发送图片已清空。",
    providerImageUnsupported: (provider) => `Provider ${provider} 不支持图片输入。请切到支持视觉的 OpenAI 模型。`,
    imageAttached: (label) => `已附加图片：${label}`,
    noSkillsFound: "未找到技能。",
    skillsCleared: "已清空启用技能。",
    skillNotFound: (name) => `未找到技能：${name}`,
    skillActivated: (id) => `技能已启用：${id}`,
    noActiveSkillFound: (name) => `当前未启用该技能：${name}`,
    skillRemoved: (ids) => `已移除技能：${ids}`,
    languageCurrent: (current, options) => `当前界面语言：${current}\n可选：${options}`,
    languageInvalid: (value, options) => `不支持的语言：${value}。可选：${options}`,
    languageUpdated: (value, envPath) => `界面语言已切换为 ${value}，并保存到 ${envPath}`,
    settingsText: ({ provider, model, thinking, effort, language, skills, pendingSkillLoads, pendingImages, maxTokens, maxSteps }) => [
      `provider: ${provider}`,
      `model: ${model ?? "（provider 默认）"}`,
      `thinking: ${thinking ? "on" : "off"}`,
      `effort: ${effort}`,
      `language: ${language}`,
      "cache: enabled",
      `maxTokens: ${maxTokens}`,
      `maxSteps: ${maxSteps}`,
      `skills: ${skills}`,
      `pendingSkillLoads: ${pendingSkillLoads}`,
      `pending images: ${pendingImages}`,
    ].join("\n"),
    runInputHint: "输入 /cancel 可中止当前运行，其他输入会排队到下一轮。",
    queuedNextInput: (text) => `下一条输入已排队：${text}`,
    cancellingRun: "正在取消当前运行...",
    cancelledRun: "正在取消当前运行...",
    permissionTitle: "权限确认",
    planApprovalPrompt: "[计划] [A]批准并执行  [R]拒绝  [E]修改计划  [N]新提示 [A]: ",
    planAutoApproved: "检测到简单/低风险任务计划，自动批准并执行。",
    promptChangedQuestion: "你希望修改什么？",
    tuiConfiguredTitle: "TUI 已更新",
    tuiConfiguredLine: (provider, model, mode, status, language) => `provider: ${provider}  ·  model: ${model}  ·  mode: ${mode}  ·  language: ${language}  ·  status: ${status}`,
    sessionStartedTitle: "会话已开始",
    activeSession: (session) => `当前会话：${session}`,
    liveMonitorTitle: "EasyCode 实时状态",
    statusLabel: "状态",
    elapsedLabel: "耗时",
    queuedNextLabel: "下一条",
    metricsLabel: "指标",
    goalPanelSummary: (status, iteration, activePlanId) => `Goal：${({ defining: "定义中", planning: "规划中", executing: "执行中", reviewing: "复核中", paused: "已暂停", blocked: "已阻塞", completed: "已完成" }[status] ?? status)}  ·  轮次：${iteration}  ·  计划：${activePlanId ?? "none"}`,
    goalPanelDetail: (objective, blocker) => blocker ? `目标：${objective}  ·  阻塞：${blocker}` : `目标：${objective}`,
    typeCancelHint: "输入 /cancel 可停止执行",
    welcomeTitle: "EasyCode TUI",
    welcomeOverview: (mode, provider, model) => `EasyCode TUI | mode=${mode} provider=${provider} model=${model}`,
    welcomeSession: (session, logger, status, language) => `session=${session} logger=${logger} language=${language} status=${status}`,
    welcomeRoot: (root) => `root=${root}`,
    welcomeCommands: "/help /settings /goal /sessions /session /model /skill /image /thinking /effort /lang /cancel",
    welcomeProjectRoot: "项目目录：",
    welcomeAgent: "AI Agent：",
    welcomeRunMode: "运行模式：",
    welcomeSessionId: "会话 ID：",
    welcomeSlashCommands: "Slash 命令：",
    welcomeCommandLines: [
      "   /help      查看帮助            /settings  查看当前设置",
      "   /goal      管理当前 goal        /sessions  查看保存会话",
      "   /session   切换或删除会话",
      "   /model     切换当前模型        /skill     管理技能",
      "   /image     附加图片输入        /lang      切换界面语言",
      "   /cancel    中止当前执行",
    ],
    successTitle: "执行完成",
    failureTitle: "执行失败",
    successStatus: "成功",
    failureStatus: "失败",
    durationLine: (duration) => `耗时：${duration}`,
    reasonLine: (reason) => `原因：${reason}`,
    roundCallsLine: (value) => `本轮调用：${value}`,
    roundTokensLine: (value, hitRate) => `本轮 Tokens：${value}${hitRate ? `（缓存命中：${hitRate}）` : ""}`,
    roundSubagentInvocationsLine: (value) => `本轮 Subagent 调用次数：${value}`,
    roundSubagentDetailLine: (value) => `本轮 Subagent 明细：${value}`,
    roundSubagentCallsLine: (value) => `本轮 Subagent 内部轮次：${value}`,
    roundSubagentTokensLine: (value) => `本轮 Subagent Tokens：${value}`,
    sessionCallsLine: (value) => `会话累计调用：${value}`,
    sessionTokensLine: (value, input, output) => `会话累计 Tokens：${value}（输入：${input}，输出：${output}）`,
    sessionSubagentCallsLine: (value) => `会话累计 Subagent 内部轮次：${value}`,
    sessionSubagentTokensLine: (value, input, output) => `会话累计 Subagent Tokens：${value}（输入：${input}，输出：${output}）`,
    statusReady: "ready",
    statusSessionSelected: "会话已选定",
    statusInitializing: "正在初始化运行...",
    statusThinking: "模型思考中...",
    statusAnswering: "模型回复中...",
    statusWaitingProvider: (provider) => `等待 ${provider} 响应...`,
    statusExecutingTool: (name) => `执行工具：${name}`,
    statusRunningTool: (name, elapsed) => `运行工具：${name}（${elapsed}）`,
    statusToolCompleted: (name) => `工具已完成：${name}`,
    statusCompacting: "正在压缩上下文...",
    statusCompactionDone: (status) => `上下文压缩：${status}`,
    statusRepoMap: (status) => `预热 repo map（${status}）`,
    statusProviderMetrics: "已接收 provider 指标",
    statusFailed: "失败",
    statusRunning: "运行中",
    statusApproved: "已批准",
    statusInputMonitor: "输入监控",
    statusQueuedInput: "输入已排队",
    statusCancelling: "取消中",
    statusPlanApproval: "计划审批",
    timelineModel: "● 模型",
    timelineWaitingFor: (provider, elapsed) => `  … 正在等待 ${provider}，已耗时 ${elapsed}\n`,
    timelineMetrics: "● 指标",
    timelineSubagentScheduled: (summary) => `● Subagent 已调度 ${summary}`,
    timelineSubagentCompleted: (role, elapsed, metrics) => `  ✓ Subagent ${role} 已完成${elapsed}${metrics}\n`,
    timelineSubagentFailed: (role, elapsed, error) => `  × Subagent ${role} 失败${elapsed}${error}\n`,
    timelineContextCompactionStart: (count) => `● 上下文压缩：正在总结旧上下文${count}`,
    timelineContextCompactionDone: (elapsed, summary, tokens) => `  ✓ 上下文已压缩${elapsed}${summary}${tokens}\n`,
    timelineContextCompactionFailed: (elapsed, error) => `  × 上下文压缩失败${elapsed}${error}\n`,
    timelineRepoMapSuccess: (cache, files, relevant, cachePath) => `● repo_map 预热 ${cache}，files=${files}${relevant}，path=${cachePath}`,
    timelineRepoMapFailed: (error) => `● repo_map 预热失败${error}`,
    timelineThought: "● 思考",
    timelineThoughtDone: (elapsed) => `  思考了 ${elapsed}s\n`,
    timelineAnswer: "● 回复",
    timelineToolRunning: (tool, elapsed) => `  … ${tool} 运行中，已耗时 ${elapsed}\n`,
    timelineGoalLifecycle: (phase, status, objective, iteration, activePlanId, blocker) => `● Goal ${({ started: "已启动", definition: "定义阶段", planning: "规划阶段", executing: "执行阶段", reviewing: "复核阶段", paused: "已暂停", blocked: "已阻塞", completed: "已完成", cleared: "已清空" }[phase] ?? phase)} status=${({ defining: "定义中", planning: "规划中", executing: "执行中", reviewing: "复核中", paused: "已暂停", blocked: "已阻塞", completed: "已完成" }[status] ?? status)}, 轮次=${iteration}, 目标=${JSON.stringify(objective)}, 计划=${activePlanId ?? "none"}${blocker ? `, 阻塞=${JSON.stringify(blocker)}` : ""}`,
    timelineMetricsBody: ({ provider, model, calls, latency, ttft, speed, inputTokens, cached, miss, hitRate, outputTokens, reasoning, total, effectiveCost, cacheHitRate, cacheMissRate, outputRate }) => [
      `  provider ${provider}${model} · calls=${calls} · latency=${latency} · ttft=${ttft} · output_rate=${speed}`,
      `  usage input=${inputTokens} cached=${cached} miss=${miss} hit_rate=${hitRate} output=${outputTokens}${reasoning}${total}`,
      `  cost effective=${effectiveCost} per_1M(cache_hit=${cacheHitRate} cache_miss=${cacheMissRate} output=${outputRate})`,
    ],
  }),
  ja: cloneWith(english, {
    helpTitle: "ヘルプ",
    webSearchTitle: "Web検索",
    webSearchNotConfigured: "ライブ Web 検索は未設定です。",
    sessionTitle: "セッション",
    sessionsTitle: "セッション",
    settingsTitle: "設定",
    commandTitle: "コマンド",
    modelTitle: "モデル",
    providerTitle: "プロバイダー",
    thinkingTitle: "思考",
    effortTitle: "強度",
    imageTitle: "画像",
    skillsTitle: "スキル",
    languageTitle: "言語",
    startingNewSession: (name) => `新しいセッションを開始: ${name}`,
    selectSession: "セッションを選択:",
    selectSessionHint: "Enter で 1 を選択、数字を入力、または新しいセッション ID を入力してください。",
    selectSessionRange: (count) => `1-${count} を入力するか、新しいセッション ID を入力してください。`,
    savedSessions: "保存済みセッション:",
    noSavedSessions: "保存済みセッションはありません。",
    noSessionStore: "セッションストアは有効ではありません。",
    commandUnknown: (name) => `不明なコマンド: /${name}。/help を使ってください。`,
    languageCurrent: (current, options) => `現在の UI 言語: ${current}\n利用可能: ${options}`,
    languageInvalid: (value, options) => `未対応の言語です: ${value}。利用可能: ${options}`,
    languageUpdated: (value, envPath) => `UI 言語を ${value} に変更し、${envPath} に保存しました`,
    runInputHint: "/cancel で現在の実行を停止できます。他の入力は次の実行にキューされます。",
    queuedNextInput: (text) => `次の入力をキューしました: ${text}`,
    cancellingRun: "現在の実行をキャンセル中...",
    cancelledRun: "現在の実行をキャンセル中...",
    permissionTitle: "権限確認",
    planApprovalPrompt: "[Plan] [A]承認して実行  [R]拒否  [E]編集  [N]新しいプロンプト [A]: ",
    planAutoApproved: "低リスクな計画が検出されました。自動承認して実行します...",
    promptChangedQuestion: "何を変更しますか？",
    tuiConfiguredTitle: "TUI 設定更新",
    sessionStartedTitle: "セッション開始",
    activeSession: (session) => `アクティブセッション: ${session}`,
    liveMonitorTitle: "EasyCode ライブモニター",
    statusLabel: "状態",
    elapsedLabel: "経過",
    queuedNextLabel: "次の入力",
    metricsLabel: "メトリクス",
    typeCancelHint: "/cancel で実行を停止",
    welcomeProjectRoot: "プロジェクトルート:",
    welcomeAgent: "AI Agent:",
    welcomeRunMode: "実行モード:",
    welcomeSessionId: "セッション ID:",
    welcomeSlashCommands: "Slash コマンド:",
    successTitle: "実行完了",
    failureTitle: "実行失敗",
    successStatus: "成功",
    failureStatus: "失敗",
    durationLine: (duration) => `所要時間: ${duration}`,
    reasonLine: (reason) => `理由: ${reason}`,
    statusSessionSelected: "セッション選択済み",
    statusInitializing: "実行を初期化中...",
    statusThinking: "モデルが思考中...",
    statusAnswering: "モデルが応答中...",
    statusWaitingProvider: (provider) => `${provider} を待機中...`,
    statusExecutingTool: (name) => `ツール実行: ${name}`,
    statusRunningTool: (name, elapsed) => `ツール実行中: ${name} (${elapsed})`,
    statusToolCompleted: (name) => `ツール完了: ${name}`,
    statusCompacting: "コンテキスト圧縮中...",
    statusCompactionDone: (status) => `コンテキスト圧縮 ${status}`,
    statusRepoMap: (status) => `repo map をプリウォーム中 (${status})`,
    statusProviderMetrics: "プロバイダーメトリクスを受信しました",
    statusFailed: "失敗",
    statusRunning: "実行中",
    statusApproved: "承認済み",
    statusInputMonitor: "入力監視",
    statusQueuedInput: "入力キュー",
    statusCancelling: "キャンセル中",
    statusPlanApproval: "プラン承認",
    timelineModel: "● モデル",
    timelineWaitingFor: (provider, elapsed) => `  … ${provider} を待機中 (${elapsed})\n`,
    timelineMetrics: "● メトリクス",
    timelineSubagentScheduled: (summary) => `● Subagent をスケジュールしました ${summary}`,
    timelineSubagentCompleted: (role, elapsed, metrics) => `  ✓ Subagent ${role} が完了しました${elapsed}${metrics}\n`,
    timelineSubagentFailed: (role, elapsed, error) => `  × Subagent ${role} が失敗しました${elapsed}${error}\n`,
    timelineContextCompactionStart: (count) => `● 古いコンテキストを要約中${count}`,
    timelineContextCompactionDone: (elapsed, summary, tokens) => `  ✓ コンテキストを圧縮しました${elapsed}${summary}${tokens}\n`,
    timelineContextCompactionFailed: (elapsed, error) => `  × コンテキスト圧縮に失敗しました${elapsed}${error}\n`,
    timelineThought: "● 思考",
    timelineThoughtDone: (elapsed) => `  ${elapsed}s 思考しました\n`,
    timelineAnswer: "● 回答",
    timelineToolRunning: (tool, elapsed) => `  … ${tool} はまだ実行中です (${elapsed})\n`,
  }),
  fr: cloneWith(english, {
    helpTitle: "Aide",
    webSearchTitle: "Recherche Web",
    webSearchNotConfigured: "La recherche web en direct n'est pas configurée.",
    sessionTitle: "Session",
    sessionsTitle: "Sessions",
    settingsTitle: "Paramètres",
    commandTitle: "Commande",
    modelTitle: "Modèle",
    providerTitle: "Fournisseur",
    thinkingTitle: "Réflexion",
    effortTitle: "Niveau",
    imageTitle: "Image",
    skillsTitle: "Compétences",
    languageTitle: "Langue",
    startingNewSession: (name) => `Nouvelle session: ${name}`,
    selectSession: "Choisissez une session :",
    selectSessionHint: "Appuyez sur Entrée pour 1, saisissez un numéro ou un nouvel identifiant de session.",
    selectSessionRange: (count) => `Choisissez 1-${count}, ou saisissez un nouvel identifiant de session.`,
    savedSessions: "Sessions enregistrées :",
    noSavedSessions: "Aucune session enregistrée.",
    noSessionStore: "Aucun stockage de session actif.",
    commandUnknown: (name) => `Commande inconnue : /${name}. Utilisez /help.`,
    languageCurrent: (current, options) => `Langue UI actuelle : ${current}\nDisponibles : ${options}`,
    languageInvalid: (value, options) => `Langue non prise en charge : ${value}. Disponibles : ${options}`,
    languageUpdated: (value, envPath) => `Langue UI définie sur ${value}. Enregistrée dans ${envPath}`,
    runInputHint: "Tapez /cancel pour arrêter cette exécution ; les autres entrées seront mises en file pour la suivante.",
    queuedNextInput: (text) => `Entrée suivante en file : ${text}`,
    cancellingRun: "Annulation de l'exécution en cours...",
    cancelledRun: "Annulation de l'exécution en cours...",
    permissionTitle: "Autorisation requise",
    planAutoApproved: "Plan à faible risque détecté. Approbation automatique et exécution...",
    promptChangedQuestion: "Que souhaitez-vous modifier ?",
    tuiConfiguredTitle: "TUI configurée",
    sessionStartedTitle: "Session démarrée",
    activeSession: (session) => `Session active : ${session}`,
    liveMonitorTitle: "Moniteur EasyCode",
    statusLabel: "Statut",
    elapsedLabel: "Temps",
    queuedNextLabel: "Prochaine entrée",
    metricsLabel: "Mesures",
    typeCancelHint: "Tapez /cancel pour arrêter l'exécution",
    welcomeProjectRoot: "Racine du projet :",
    welcomeAgent: "Agent IA :",
    welcomeRunMode: "Mode :",
    welcomeSessionId: "Session :",
    welcomeSlashCommands: "Commandes slash :",
    successTitle: "Exécution terminée",
    failureTitle: "Échec de l'exécution",
    successStatus: "SUCCÈS",
    failureStatus: "ÉCHEC",
    durationLine: (duration) => `Durée : ${duration}`,
    reasonLine: (reason) => `Raison : ${reason}`,
    statusSessionSelected: "session sélectionnée",
    statusInitializing: "Initialisation de l'exécution...",
    statusThinking: "Le modèle réfléchit...",
    statusAnswering: "Le modèle répond...",
    statusWaitingProvider: (provider) => `En attente de ${provider}...`,
    statusExecutingTool: (name) => `Exécution de l'outil : ${name}`,
    statusRunningTool: (name, elapsed) => `Outil en cours : ${name} (${elapsed})`,
    statusToolCompleted: (name) => `Outil terminé : ${name}`,
    statusCompacting: "Compression du contexte...",
    statusCompactionDone: (status) => `Compression du contexte ${status}`,
    statusRepoMap: (status) => `Préchauffage repo map (${status})`,
    statusProviderMetrics: "Mesures du fournisseur reçues",
    statusFailed: "échec",
    statusRunning: "en cours",
    statusApproved: "approuvé",
    statusInputMonitor: "surveillance entrée",
    statusQueuedInput: "entrée en file",
    statusCancelling: "annulation",
    statusPlanApproval: "approbation du plan",
    timelineModel: "● Modèle",
    timelineWaitingFor: (provider, elapsed) => `  … attente de ${provider} après ${elapsed}\n`,
    timelineMetrics: "● Mesures",
    timelineSubagentScheduled: (summary) => `● Subagent planifié ${summary}`,
    timelineSubagentCompleted: (role, elapsed, metrics) => `  ✓ Subagent ${role} terminé${elapsed}${metrics}\n`,
    timelineSubagentFailed: (role, elapsed, error) => `  × Subagent ${role} en échec${elapsed}${error}\n`,
    timelineThought: "● Réflexion",
    timelineThoughtDone: (elapsed) => `  Réflexion pendant ${elapsed}s\n`,
    timelineAnswer: "● Réponse",
  }),
  ko: cloneWith(english, {
    helpTitle: "도움말",
    webSearchTitle: "웹 검색",
    webSearchNotConfigured: "실시간 웹 검색이 설정되어 있지 않습니다.",
    sessionTitle: "세션",
    sessionsTitle: "세션",
    settingsTitle: "설정",
    commandTitle: "명령",
    modelTitle: "모델",
    providerTitle: "프로바이더",
    thinkingTitle: "사고",
    effortTitle: "강도",
    imageTitle: "이미지",
    skillsTitle: "스킬",
    languageTitle: "언어",
    startingNewSession: (name) => `새 세션 시작: ${name}`,
    selectSession: "세션 선택:",
    selectSessionHint: "Enter 를 누르면 1번을 선택합니다. 번호를 입력하거나 새 세션 ID 를 입력하세요.",
    selectSessionRange: (count) => `1-${count} 중에서 선택하거나 새 세션 ID 를 입력하세요.`,
    savedSessions: "저장된 세션:",
    noSavedSessions: "저장된 세션이 없습니다.",
    noSessionStore: "활성 세션 저장소가 없습니다.",
    commandUnknown: (name) => `알 수 없는 명령: /${name}. /help 를 사용하세요.`,
    languageCurrent: (current, options) => `현재 UI 언어: ${current}\n사용 가능: ${options}`,
    languageInvalid: (value, options) => `지원하지 않는 언어입니다: ${value}. 사용 가능: ${options}`,
    languageUpdated: (value, envPath) => `UI 언어를 ${value}(으)로 설정했고 ${envPath}에 저장했습니다`,
    runInputHint: "/cancel 로 현재 실행을 중단할 수 있습니다. 다른 입력은 다음 실행에 대기열로 들어갑니다.",
    queuedNextInput: (text) => `다음 입력이 대기열에 추가됨: ${text}`,
    cancellingRun: "현재 실행을 취소하는 중...",
    cancelledRun: "현재 실행을 취소하는 중...",
    permissionTitle: "권한 확인",
    planAutoApproved: "낮은 위험도의 계획이 감지되었습니다. 자동 승인 및 실행 중...",
    promptChangedQuestion: "무엇을 변경하시겠습니까?",
    tuiConfiguredTitle: "TUI 설정됨",
    sessionStartedTitle: "세션 시작됨",
    activeSession: (session) => `활성 세션: ${session}`,
    liveMonitorTitle: "EasyCode 라이브 모니터",
    statusLabel: "상태",
    elapsedLabel: "경과",
    queuedNextLabel: "다음 입력",
    metricsLabel: "지표",
    typeCancelHint: "/cancel 로 실행 중단",
    welcomeProjectRoot: "프로젝트 루트:",
    welcomeAgent: "AI Agent:",
    welcomeRunMode: "실행 모드:",
    welcomeSessionId: "세션 ID:",
    welcomeSlashCommands: "슬래시 명령:",
    successTitle: "실행 완료",
    failureTitle: "실행 실패",
    successStatus: "성공",
    failureStatus: "실패",
    durationLine: (duration) => `소요 시간: ${duration}`,
    reasonLine: (reason) => `이유: ${reason}`,
    statusSessionSelected: "세션 선택됨",
    statusInitializing: "실행 초기화 중...",
    statusThinking: "모델이 생각 중...",
    statusAnswering: "모델이 응답 중...",
    statusWaitingProvider: (provider) => `${provider} 응답 대기 중...`,
    statusExecutingTool: (name) => `도구 실행: ${name}`,
    statusRunningTool: (name, elapsed) => `도구 실행 중: ${name} (${elapsed})`,
    statusToolCompleted: (name) => `도구 완료: ${name}`,
    statusCompacting: "컨텍스트 압축 중...",
    statusCompactionDone: (status) => `컨텍스트 압축 ${status}`,
    statusRepoMap: (status) => `repo map 예열 중 (${status})`,
    statusProviderMetrics: "프로바이더 지표 수신 완료",
    statusFailed: "실패",
    statusRunning: "실행 중",
    statusApproved: "승인됨",
    statusInputMonitor: "입력 모니터",
    statusQueuedInput: "입력 대기열",
    statusCancelling: "취소 중",
    statusPlanApproval: "계획 승인",
    timelineModel: "● 모델",
    timelineWaitingFor: (provider, elapsed) => `  … ${provider} 대기 중 (${elapsed})\n`,
    timelineMetrics: "● 지표",
    timelineSubagentScheduled: (summary) => `● Subagent 예약됨 ${summary}`,
    timelineSubagentCompleted: (role, elapsed, metrics) => `  ✓ Subagent ${role} 완료${elapsed}${metrics}\n`,
    timelineSubagentFailed: (role, elapsed, error) => `  × Subagent ${role} 실패${elapsed}${error}\n`,
    timelineThought: "● 사고",
    timelineThoughtDone: (elapsed) => `  ${elapsed}s 동안 사고함\n`,
    timelineAnswer: "● 답변",
  }),
  de: cloneWith(english, {
    helpTitle: "Hilfe",
    webSearchTitle: "Websuche",
    webSearchNotConfigured: "Die Live-Websuche ist nicht konfiguriert.",
    sessionTitle: "Sitzung",
    sessionsTitle: "Sitzungen",
    settingsTitle: "Einstellungen",
    commandTitle: "Befehl",
    modelTitle: "Modell",
    providerTitle: "Provider",
    thinkingTitle: "Denken",
    effortTitle: "Stufe",
    imageTitle: "Bild",
    skillsTitle: "Skills",
    languageTitle: "Sprache",
    startingNewSession: (name) => `Neue Sitzung gestartet: ${name}`,
    selectSession: "Sitzung auswählen:",
    selectSessionHint: "Drücken Sie Enter für 1, geben Sie eine Zahl oder eine neue Sitzungs-ID ein.",
    selectSessionRange: (count) => `Wählen Sie 1-${count} oder geben Sie eine neue Sitzungs-ID ein.`,
    savedSessions: "Gespeicherte Sitzungen:",
    noSavedSessions: "Keine gespeicherten Sitzungen.",
    noSessionStore: "Kein Sitzungsspeicher aktiv.",
    commandUnknown: (name) => `Unbekannter Befehl: /${name}. Verwenden Sie /help.`,
    languageCurrent: (current, options) => `Aktuelle UI-Sprache: ${current}\nVerfügbar: ${options}`,
    languageInvalid: (value, options) => `Nicht unterstützte Sprache: ${value}. Verfügbar: ${options}`,
    languageUpdated: (value, envPath) => `UI-Sprache auf ${value} gesetzt. In ${envPath} gespeichert`,
    runInputHint: "Mit /cancel stoppen Sie den aktuellen Lauf; andere Eingaben werden für den nächsten Lauf vorgemerkt.",
    queuedNextInput: (text) => `Nächste Eingabe vorgemerkt: ${text}`,
    cancellingRun: "Aktuellen Lauf wird abgebrochen...",
    cancelledRun: "Aktuellen Lauf wird abgebrochen...",
    permissionTitle: "Berechtigung erforderlich",
    planAutoApproved: "Plan mit geringem Risiko erkannt. Automatische Genehmigung und Ausführung...",
    promptChangedQuestion: "Was möchten Sie ändern?",
    tuiConfiguredTitle: "TUI konfiguriert",
    sessionStartedTitle: "Sitzung gestartet",
    activeSession: (session) => `Aktive Sitzung: ${session}`,
    liveMonitorTitle: "EasyCode Live-Monitor",
    statusLabel: "Status",
    elapsedLabel: "Dauer",
    queuedNextLabel: "Nächste Eingabe",
    metricsLabel: "Metriken",
    typeCancelHint: "Mit /cancel Ausführung stoppen",
    welcomeProjectRoot: "Projektwurzel:",
    welcomeAgent: "KI-Agent:",
    welcomeRunMode: "Modus:",
    welcomeSessionId: "Sitzung:",
    welcomeSlashCommands: "Slash-Befehle:",
    successTitle: "Ausführung abgeschlossen",
    failureTitle: "Ausführung fehlgeschlagen",
    successStatus: "ERFOLG",
    failureStatus: "FEHLER",
    durationLine: (duration) => `Dauer: ${duration}`,
    reasonLine: (reason) => `Grund: ${reason}`,
    statusSessionSelected: "Sitzung ausgewählt",
    statusInitializing: "Ausführung wird initialisiert...",
    statusThinking: "Modell denkt nach...",
    statusAnswering: "Modell antwortet...",
    statusWaitingProvider: (provider) => `Warte auf ${provider}...`,
    statusExecutingTool: (name) => `Werkzeug ausführen: ${name}`,
    statusRunningTool: (name, elapsed) => `Werkzeug läuft: ${name} (${elapsed})`,
    statusToolCompleted: (name) => `Werkzeug abgeschlossen: ${name}`,
    statusCompacting: "Kontext wird komprimiert...",
    statusCompactionDone: (status) => `Kontextkomprimierung ${status}`,
    statusRepoMap: (status) => `repo_map wird vorgewärmt (${status})`,
    statusProviderMetrics: "Provider-Metriken empfangen",
    statusFailed: "fehlgeschlagen",
    statusRunning: "läuft",
    statusApproved: "genehmigt",
    statusInputMonitor: "Eingabemonitor",
    statusQueuedInput: "Eingabe vorgemerkt",
    statusCancelling: "abbrechen",
    statusPlanApproval: "Planfreigabe",
    timelineModel: "● Modell",
    timelineWaitingFor: (provider, elapsed) => `  … warte auf ${provider} seit ${elapsed}\n`,
    timelineMetrics: "● Metriken",
    timelineSubagentScheduled: (summary) => `● Subagent geplant ${summary}`,
    timelineSubagentCompleted: (role, elapsed, metrics) => `  ✓ Subagent ${role} abgeschlossen${elapsed}${metrics}\n`,
    timelineSubagentFailed: (role, elapsed, error) => `  × Subagent ${role} fehlgeschlagen${elapsed}${error}\n`,
    timelineThought: "● Denken",
    timelineThoughtDone: (elapsed) => `  ${elapsed}s nachgedacht\n`,
    timelineAnswer: "● Antwort",
  }),
}

export function uiText(language: UiLanguage | string | undefined) {
  return copies[normalizeUiLanguage(typeof language === "string" ? language : language ?? "en")]
}

export function languageDisplay(language: UiLanguage | string | undefined) {
  const normalized = normalizeUiLanguage(typeof language === "string" ? language : language ?? "en")
  return `${normalized} (${languageLabel(normalized)})`
}

export function uiLanguageChoices() {
  return formatLanguageChoices()
}
