import { useState } from "react"
import type { MarkdownFileOpenHandler, PermissionPrompt, PlanPrompt } from "./app-types.js"
import { MarkdownText } from "./message-stream.js"
import { sidecarPermissionReply, type PermissionReplyAction } from "./permission-state.js"
import { canSubmitPlanDraft, displayPlanMarkdown, planReplyPayload, type PlanReplyAction } from "./plan-goal-state.js"

const noopOpenFile: MarkdownFileOpenHandler = async () => undefined

export function PermissionModal({ onClose, onError, prompt }: { prompt: PermissionPrompt; onClose: () => void; onError: (error: unknown, prefix?: string) => void }) {
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

export function PlanModal({ onClose, onError, prompt }: { prompt: PlanPrompt; onClose: () => void; onError: (error: unknown, prefix?: string) => void }) {
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
