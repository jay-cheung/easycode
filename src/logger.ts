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
    console.info(`[easycode] ${JSON.stringify(event)}`)
  }
}
