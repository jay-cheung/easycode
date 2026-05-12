export type LogEventType = "state" | "data" | "context" | "provider" | "tool" | "error"

export type LogEvent = {
  at: number
  type: LogEventType
  name: string
  detail?: Record<string, unknown>
}

export type Logger = (event: LogEvent) => void

export function emitLog(logger: Logger | undefined, event: Omit<LogEvent, "at">) {
  if (!logger) return
  logger({ at: Date.now(), ...event })
}

export function createLogger(): Logger {
  return (event) => {
    const write = event.type === "error" ? console.error : console.info
    write(formatLogEvent(event))
  }
}

export function formatLogEvent(event: LogEvent) {
  const line = `[easycode] ${JSON.stringify(event)}`
  if (event.type === "provider" && (event.name === "provider.request" || event.name === "provider.response" || event.name === "provider.response.raw")) return `\x1b[1;33m${line}\x1b[0m`
  if (event.type === "state") return `\x1b[1;36m${line}\x1b[0m`
  return line
}
