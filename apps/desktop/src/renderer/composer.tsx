import type { DesktopProviderReadiness, DesktopReasoningEffort, DesktopSettings } from "../shared/protocol.js"
import type { Attachment, PermissionMode, RunMode, SelectOption } from "./app-types.js"
import { providerReadinessLabel } from "./provider-readiness.js"
import { isRunProducingSlashInput, queuedInputLabel } from "./run-queue.js"
import { defaultSetupModel, effortSelectOptions, modelSelectOptions, normalizeSelectOptions } from "./select-options.js"

export type ComposerCopy = {
  addFiles: string
  ask: string
  attachedCount: (count: number) => string
  autoReview: string
  build: string
  cancel: string
  clearAll: string
  composerPlaceholder: string
  effort: string
  effortHigh: string
  effortLow: string
  effortMax: string
  effortMedium: string
  goal: string
  goalRestricted: string
  goalRestrictedTitle: string
  model: string
  permission: string
  plan: string
  providerNotReady: string
  send: string
}

export function Composer({ attachments, copy, onCancelRun, onChangeEffort, onChangeModel, onClearAttachments, onPickFiles, onRemoveAttachment, permissionMode, prompt, providerReady, providerReadiness, queuedCount, runMode, running, sendPrompt, setPermissionMode, setPrompt, setRunMode, settings }: {
  attachments: Attachment[]
  copy: ComposerCopy
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
