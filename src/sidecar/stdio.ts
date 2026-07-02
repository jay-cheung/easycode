import { stdin, stdout } from "node:process"
import { encodeSidecarEvent, encodeSidecarResponse, parseSidecarRequestLine, sidecarErrorResponse } from "./jsonl"
import { SidecarService } from "./service"
import type { SidecarRequest } from "./types"

export async function runSidecarStdio(argv: string[] = []) {
  configureSidecarStdioArgs(argv)
  const service = new SidecarService((event) => stdout.write(encodeSidecarEvent(event)))
  let buffer = ""
  let shutdownRequested = false
  let queue = Promise.resolve()

  const handleRequest = async (request: SidecarRequest) => {
    try {
      const result = await service.handle(request)
      stdout.write(encodeSidecarResponse({ id: request.id, ok: true, result }))
      if (request.method === "shutdown") shutdownRequested = true
    } catch (error) {
      stdout.write(encodeSidecarResponse(sidecarErrorResponse(request.id, error)))
    }
    if (shutdownRequested) setTimeout(() => process.exit(0), 0)
  }

  const handleLine = async (line: string) => {
    if (!line.trim()) return
    let request: SidecarRequest
    try {
      request = parseSidecarRequestLine(line)
    } catch (error) {
      stdout.write(encodeSidecarResponse(sidecarErrorResponse("unknown", error)))
      return
    }
    await handleRequest(request)
  }

  const enqueueLine = (line: string) => {
    queue = queue.then(() => handleLine(line), () => handleLine(line))
    return queue
  }

  const dispatchLine = (line: string) => {
    if (!line.trim()) return
    let request: SidecarRequest
    try {
      request = parseSidecarRequestLine(line)
    } catch (error) {
      stdout.write(encodeSidecarResponse(sidecarErrorResponse("unknown", error)))
      return
    }
    if (shouldHandleImmediately(request)) {
      void handleRequest(request)
      return
    }
    queue = queue.then(() => handleRequest(request), () => handleRequest(request))
  }

  stdin.setEncoding("utf8")
  for await (const chunk of stdin) {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      dispatchLine(line)
    }
  }
  if (buffer.trim()) await enqueueLine(buffer)
  await queue
}

export function configureSidecarStdioArgs(argv: string[] = []) {
  if (!argv.includes("--stdio")) throw new Error("Usage: easycode sidecar --stdio [--insecure|-k]")
  if (argv.includes("--insecure") || argv.includes("-k")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
}

export function shouldHandleImmediately(request: Pick<SidecarRequest, "method">) {
  return request.method === "cancelRun" || request.method === "replyPermission" || request.method === "replyPlan"
}
