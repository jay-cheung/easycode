import { useState, type FormEvent } from "react"
import type { DesktopProviderReadiness, DesktopProviderSetup, DesktopProviderSetupResult, DesktopSettings } from "../shared/protocol.js"
import { providerSetupRequirements, providerSetupStatus } from "./provider-readiness.js"
import { defaultSetupModel, modelSelectOptions } from "./select-options.js"

export function ProviderSetupModal({ onClose, onConfigured, providerOptions, readiness, settings }: {
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
  const submit = async (event: FormEvent) => {
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
