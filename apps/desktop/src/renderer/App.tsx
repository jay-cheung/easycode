import { useEffect, useState, type Dispatch, type SetStateAction } from "react"
import type { DesktopSettings, SidecarFrame } from "../shared/protocol.js"

type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "tool"; title: string; detail: string; open: boolean }
  | { id: string; kind: "status"; text: string }

type PermissionPrompt = { requestId: string; title: string }
type PlanPrompt = { runId: string; markdown: string }

export function App() {
  const [settings, setSettings] = useState<DesktopSettings>()
  const [items, setItems] = useState<ChatItem[]>([])
  const [prompt, setPrompt] = useState("")
  const [running, setRunning] = useState(false)
  const [permission, setPermission] = useState<PermissionPrompt>()
  const [plan, setPlan] = useState<PlanPrompt>()

  useEffect(() => {
    void window.easycode.settings().then(setSettings)
    const off = window.easycode.onSidecarEvent(handleFrame)
    void window.easycode.initialize().then(() => window.easycode.listSessions())
    return off
  }, [])

  const handleFrame = (frame: SidecarFrame) => {
    if (!("type" in frame) || frame.type !== "event") return
    const event = frame.event
    if (event.type === "text_delta") appendAssistant(event.text)
    else if (event.type === "tool_call") appendTool(event.call.name, JSON.stringify(event.call.input, null, 2))
    else if (event.type === "tool_result") appendTool(event.title || event.toolName, event.output)
    else if (event.type === "permission_request") setPermission({ requestId: event.request.id, title: `${event.request.permission}: ${event.request.patterns.join(", ")}` })
    else if (event.type === "plan_approval_request") setPlan({ runId: frame.runId!, markdown: event.markdown })
    else if (event.type === "run_done") setRunning(false)
    else if (event.type === "fatal") appendStatus(event.message)
  }

  const sendPrompt = async () => {
    const text = prompt.trim()
    if (!text || running) return
    setPrompt("")
    setRunning(true)
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "user", text }, { id: crypto.randomUUID(), kind: "assistant", text: "" }])
    try {
      await window.easycode.runPrompt(text)
    } catch (error) {
      appendStatus(error instanceof Error ? error.message : String(error))
      setRunning(false)
    }
  }

  const updateSettings = async (patch: Partial<DesktopSettings>) => {
    const next = await window.easycode.updateSettings(patch)
    setSettings(next)
    await window.easycode.initialize()
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">EasyCode</div>
        <label>
          Workspace
          <input value={settings?.workspaceRoot ?? ""} onChange={(event) => setSettings(settings ? { ...settings, workspaceRoot: event.target.value } : undefined)} onBlur={() => settings && updateSettings({ workspaceRoot: settings.workspaceRoot })} />
        </label>
        <label>
          Sidecar
          <input placeholder="Bundled or PATH easycode" value={settings?.sidecarPath ?? ""} onChange={(event) => setSettings(settings ? { ...settings, sidecarPath: event.target.value } : undefined)} onBlur={() => settings && updateSettings({ sidecarPath: settings.sidecarPath })} />
        </label>
        <label>
          Provider
          <select value={settings?.provider ?? "fake"} onChange={(event) => updateSettings({ provider: event.target.value })}>
            <option value="fake">fake</option>
            <option value="deepseek">deepseek</option>
            <option value="openai">openai</option>
            <option value="openai-compatible">openai-compatible</option>
          </select>
        </label>
      </aside>
      <section className="chat">
        <header>
          <span>{settings?.session ?? "default"}</span>
          <button onClick={() => window.easycode.cancelRun()} disabled={!running}>Cancel</button>
        </header>
        <div className="stream">
          {items.map((item) => item.kind === "tool" ? <ToolRow key={item.id} item={item} setItems={setItems} /> : <Message key={item.id} item={item} />)}
        </div>
        <footer>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendPrompt()
          }} placeholder="Ask EasyCode to inspect, explain, plan, or change this repository." />
          <button onClick={sendPrompt} disabled={running || !prompt.trim()}>Send</button>
        </footer>
      </section>
      {permission && <PermissionModal prompt={permission} onClose={() => setPermission(undefined)} />}
      {plan && <PlanModal prompt={plan} onClose={() => setPlan(undefined)} />}
    </main>
  )

  function appendAssistant(text: string) {
    setItems((current) => current.map((item, index) => index === current.length - 1 && item.kind === "assistant" ? { ...item, text: item.text + text } : item))
  }

  function appendTool(title: string, detail: string) {
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "tool", title, detail, open: false }])
  }

  function appendStatus(text: string) {
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: "status", text }])
  }
}

function Message({ item }: { item: Exclude<ChatItem, { kind: "tool" }> }) {
  return <article className={`message ${item.kind}`}><pre>{item.text || "..."}</pre></article>
}

function ToolRow({ item, setItems }: { item: Extract<ChatItem, { kind: "tool" }>; setItems: Dispatch<SetStateAction<ChatItem[]>> }) {
  return <article className="tool"><button onClick={() => setItems((items) => items.map((row) => row.id === item.id && row.kind === "tool" ? { ...row, open: !row.open } : row))}>{item.open ? "Hide" : "Show"} {item.title}</button>{item.open && <pre>{item.detail}</pre>}</article>
}

function PermissionModal({ prompt, onClose }: { prompt: PermissionPrompt; onClose: () => void }) {
  const reply = async (value: "once" | "always" | "reject") => {
    await window.easycode.replyPermission(prompt.requestId, value)
    onClose()
  }
  return <div className="modal"><section><h2>Permission</h2><p>{prompt.title}</p><button onClick={() => reply("once")}>Allow Once</button><button onClick={() => reply("always")}>Always</button><button onClick={() => reply("reject")}>Reject</button></section></div>
}

function PlanModal({ prompt, onClose }: { prompt: PlanPrompt; onClose: () => void }) {
  const reply = async (action: "approve" | "reject") => {
    await window.easycode.replyPlan(prompt.runId, action)
    onClose()
  }
  return <div className="modal"><section><h2>Plan</h2><pre>{prompt.markdown}</pre><button onClick={() => reply("approve")}>Approve</button><button onClick={() => reply("reject")}>Reject</button></section></div>
}
