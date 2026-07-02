import { useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { DesktopMessage, DesktopMessagePart, DesktopSessionSummary } from "../shared/protocol.js"
import type { AssistantRenderPart, AssistantTurnPart, ChatItem, MarkdownFileOpenHandler, MessageItem, StreamEntry, ToolItem } from "./app-types.js"
import { EmptyState } from "./empty-state.js"
import { assistantErrorPresentation } from "./message-error.js"
import { truncateSessionTitle } from "./session-workspace-state.js"

export type MessageStreamCopy = {
  activity: string
  callCount: (count: number) => string
  certificateIssueDetail: string
  certificateIssueTitle: string
  completed: string
  copyOutput: string
  details: string
  hide: string
  noMessages: string
  reasoning: string
  reasoningCount: (count: number) => string
  runFailed: string
  runFailedHint: string
  running: string
  show: string
  showFullResponse: string
  showLess: string
  startSession: string
  starterPrompts: string[]
  toolCallCount: (count: number) => string
  tools: string
  waitingForModel: string
  you: string
}

export function MessageStream({
  copy,
  items,
  onOpenFile,
  onSelectPrompt,
  streamRef,
}: {
  copy: MessageStreamCopy
  items: ChatItem[]
  onOpenFile: MarkdownFileOpenHandler
  onSelectPrompt: (prompt: string) => void
  streamRef: React.RefObject<HTMLDivElement | null>
}) {
  const entries = groupStreamItems(items)
  return <div className="stream" ref={streamRef}>
    {entries.length === 0 && <EmptyState copy={copy} onSelectPrompt={onSelectPrompt} />}
    {entries.map((entry) => entry.kind === "assistantTurn"
      ? <AssistantTurn copy={copy} key={entry.id} entry={entry} onOpenFile={onOpenFile} />
      : <Message copy={copy} key={entry.id} item={entry.item} onOpenFile={onOpenFile} />)}
  </div>
}

export function groupStreamItems(items: ChatItem[]): StreamEntry[] {
  const entries: StreamEntry[] = []
  let pendingTools: ToolItem[] = []
  let pendingAssistantParts: AssistantTurnPart[] = []

  const flushTools = () => {
    if (pendingTools.length === 0) return
    pendingAssistantParts.push({ id: `tools-${pendingTools[0].id}`, kind: "tools", tools: pendingTools })
    pendingTools = []
  }

  const flushAssistantTurn = () => {
    flushTools()
    if (pendingAssistantParts.length === 0) return
    const first = pendingAssistantParts[0]
    const firstAssistant = pendingAssistantParts.find((part) => part.kind === "assistant")
    entries.push({
      id: `assistant-turn-${first.id}`,
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

export function isPlanControlTool(name: string) {
  return name === "plan_step_complete" || name === "plan_step_fail"
}

export function isGoalControlTool(name: string) {
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

function Message({ copy, item, onOpenFile }: { copy: MessageStreamCopy; item: Exclude<MessageItem, { kind: "assistant" }>; onOpenFile: MarkdownFileOpenHandler }) {
  if (item.kind === "status") return <article className="message status"><MarkdownText onOpenFile={onOpenFile} text={item.text} /></article>
  return <article className={`message ${item.kind}`}><div className="message-head"><strong>{item.kind === "user" ? copy.you : "EasyCode"}</strong><time>{item.time}</time></div><MessageText copy={copy} onOpenFile={onOpenFile} text={item.text || "..."} /></article>
}

function AssistantTurn({ copy, entry, onOpenFile }: { copy: MessageStreamCopy; entry: Extract<StreamEntry, { kind: "assistantTurn" }>; onOpenFile: MarkdownFileOpenHandler }) {
  const [expanded, setExpanded] = useState(false)
  const parts = groupAssistantActivity(entry.parts)
  const outputText = assistantOutputText(parts)
  const shouldCollapse = responseShouldCollapse(outputText, parts)
  const compact = shouldCollapse && !expanded
  return <article className="message assistant assistant-turn">
    <div className="message-head">
      <strong>EasyCode</strong>
      <div className="message-actions">
        {entry.time && <time>{entry.time}</time>}
        {outputText && <button className="copy-output" onClick={() => { void copyToClipboard(outputText) }} aria-label={copy.copyOutput} title={copy.copyOutput}><span className="copy-icon" /></button>}
      </div>
    </div>
    <div className={`message-body ${compact ? "response-compact" : ""}`}>
      {parts.map((part) => part.kind === "activity"
        ? <ActivityGroup copy={copy} key={part.id} onOpenFile={onOpenFile} parts={part.parts} />
        : part.kind === "tools"
          ? <ToolGroup copy={copy} key={part.id} tools={part.tools} />
          : part.item.pending
            ? <PendingAssistant copy={copy} key={part.id} />
            : <MessageText allowErrorCard copy={copy} key={part.id} onOpenFile={onOpenFile} text={part.item.text || "..."} />)}
    </div>
    {shouldCollapse && <button className="response-expand" onClick={() => setExpanded((value) => !value)} type="button">{expanded ? copy.showLess : copy.showFullResponse}</button>}
  </article>
}

function ActivityGroup({ copy, onOpenFile, parts }: { copy: MessageStreamCopy; onOpenFile: MarkdownFileOpenHandler; parts: AssistantTurnPart[] }) {
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
        : part.item.pending
          ? <PendingAssistant copy={copy} key={part.id} />
          : <MessageText allowErrorCard copy={copy} key={part.id} onOpenFile={onOpenFile} text={part.item.text || "..."} />)}
    </div>}
  </article>
}

function PendingAssistant({ copy }: { copy: MessageStreamCopy }) {
  return <div className="pending-assistant">
    <span className="pending-dot" />
    <strong>{copy.waitingForModel}</strong>
  </div>
}

function MessageText({ allowErrorCard, copy, onOpenFile, text }: { allowErrorCard?: boolean; copy: MessageStreamCopy; onOpenFile: MarkdownFileOpenHandler; text: string }) {
  const error = allowErrorCard ? assistantErrorPresentation(text, copy) : undefined
  if (error) return <div className="message-body">
    <section className="message-error-card">
      <div className="message-error-title"><span className="message-error-dot" /><strong>{error.title}</strong></div>
      <p>{error.detail}</p>
      <small>{error.hint}</small>
    </section>
  </div>
  return <div className="message-body">
    {splitReasoningBlocks(text).map((part, index) => part.kind === "reasoning"
      ? <ReasoningBlock copy={copy} key={`${part.kind}-${index}`} onOpenFile={onOpenFile} text={part.text} />
      : <MarkdownText key={`${part.kind}-${index}`} onOpenFile={onOpenFile} text={part.text} />)}
  </div>
}

export function MarkdownText({ onOpenFile, text }: { onOpenFile: MarkdownFileOpenHandler; text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: (props) => <InlineCode {...props} onOpenFile={onOpenFile} /> }}>{text}</ReactMarkdown></div>
}

function InlineCode(props: { children?: ReactNode; className?: string; onOpenFile: MarkdownFileOpenHandler }) {
  const text = String(props.children ?? "").trim()
  const target = workspaceFileTarget(text)
  if (!props.className && target) {
    return <button className="file-link" onClick={() => {
      void props.onOpenFile(target)
    }}>{text}</button>
  }
  return <code className={props.className}>{props.children}</code>
}

function ReasoningBlock({ copy, onOpenFile, text }: { copy: MessageStreamCopy; onOpenFile: MarkdownFileOpenHandler; text: string }) {
  const [open, setOpen] = useState(false)
  return <section className={`reasoning-fold ${open ? "open" : ""}`}>
    <button onClick={() => setOpen((value) => !value)}>
      <span>{copy.reasoning}</span>
      <small>{open ? copy.hide : reasoningPreview(text)}</small>
    </button>
    {open && <MarkdownText onOpenFile={onOpenFile} text={text} />}
  </section>
}

function ToolGroup({ copy, tools }: { copy: MessageStreamCopy; tools: ToolItem[] }) {
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

export function sessionTitle(session: DesktopSessionSummary) {
  return truncateSessionTitle(safeSessionTitle(session.title || session.id))
}

export function fullSessionTitle(session: DesktopSessionSummary) {
  return safeSessionTitle(session.title || session.id)
}

export function firstDisplayUserTitle(items: ChatItem[]) {
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

export function safeSessionTitle(title: string) {
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

function activitySummary(copy: MessageStreamCopy, reasoningCount: number, toolCallCount: number) {
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

function responseShouldCollapse(outputText: string, parts: AssistantRenderPart[]) {
  if (parts.some((part) => part.kind !== "assistant")) return parts.length > 8 || outputText.length > 2600
  return outputText.length > 1800
}

function assistantOutputText(parts: AssistantRenderPart[]) {
  return parts.flatMap((part) => {
    if (part.kind === "activity" || part.kind === "tools") return []
    if (part.item.pending) return []
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

export function messagesToItems(messages: DesktopMessage[]): ChatItem[] {
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
