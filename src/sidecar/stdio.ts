import { stdin, stdout } from "node:process"
import { encodeSidecarEvent, encodeSidecarResponse, parseSidecarRequestLine, sidecarErrorResponse } from "./jsonl"
import { SidecarService } from "./service"

export async function runSidecarStdio(argv: string[] = []) {
  if (!argv.includes("--stdio")) throw new Error("Usage: easycode sidecar --stdio")
  const service = new SidecarService((event) => stdout.write(encodeSidecarEvent(event)))
  let buffer = ""
  let shutdownRequested = false

  const handleLine = async (line: string) => {
    if (!line.trim()) return
    let requestId = "unknown"
    try {
      const request = parseSidecarRequestLine(line)
      requestId = request.id
      const result = await service.handle(request)
      stdout.write(encodeSidecarResponse({ id: request.id, ok: true, result }))
      if (request.method === "shutdown") shutdownRequested = true
    } catch (error) {
      stdout.write(encodeSidecarResponse(sidecarErrorResponse(requestId, error)))
    }
    if (shutdownRequested) setTimeout(() => process.exit(0), 0)
  }

  stdin.setEncoding("utf8")
  for await (const chunk of stdin) {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      void handleLine(line)
    }
  }
  if (buffer.trim()) await handleLine(buffer)
}
