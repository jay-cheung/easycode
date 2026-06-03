import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

const children: ChildProcessWithoutNullStreams[] = []

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop()
    child?.kill("SIGTERM")
  }
})

function encodeMessage(message: JsonRpcRequest) {
  const body = JSON.stringify(message)
  const bytes = Buffer.byteLength(body, "utf8")
  return `Content-Length: ${bytes}\r\nContent-Type: application/json\r\n\r\n${body}`
}

class ResponseCollector {
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>()

  attach(child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.tryParseOne()) {
        continue
      }
    })

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim()
      if (text.length > 0) {
        for (const request of this.pending.values()) {
          request.reject(new Error(`server stderr: ${text}`))
        }
        this.pending.clear()
      }
    })
  }

  waitFor(id: number) {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  private tryParseOne() {
    const headerEnd = this.buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return false

    const header = this.buffer.subarray(0, headerEnd).toString("utf8")
    const contentLengthLine = header.split("\r\n").find((line) => line.toLowerCase().startsWith("content-length:"))
    if (!contentLengthLine) {
      throw new Error("Missing Content-Length in response")
    }
    const contentLength = Number.parseInt(contentLengthLine.slice("content-length:".length).trim(), 10)
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength
    if (this.buffer.length < bodyEnd) return false

    const payload = JSON.parse(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as JsonRpcResponse
    this.buffer = this.buffer.subarray(bodyEnd)
    const pending = payload.id === null ? undefined : this.pending.get(payload.id)
    if (pending && payload.id !== null) {
      this.pending.delete(payload.id)
      pending.resolve(payload)
    }
    return true
  }
}

function spawnServer() {
  const root = path.resolve(import.meta.dir, "../..")
  const child = spawn(process.execPath, ["run", path.join(root, "dev/mcp/test-server.ts")], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  })
  children.push(child)
  const collector = new ResponseCollector()
  collector.attach(child)
  return {
    child,
    async request(id: number, method: string, params?: unknown) {
      const pending = collector.waitFor(id)
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }))
      return pending
    },
    notify(method: string, params?: unknown) {
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }))
    },
  }
}

describe("local MCP test server", () => {
  test("supports initialize, tools, resources, prompts, and ping over stdio framing", async () => {
    const server = spawnServer()

    const init = await server.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "easycode-test", version: "0.1.0" },
    })
    expect(init.error).toBeUndefined()
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05")

    server.notify("notifications/initialized")

    const tools = await server.request(2, "tools/list")
    expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(["echo", "sum", "get_server_state"])

    const echo = await server.request(3, "tools/call", {
      name: "echo",
      arguments: { text: "hello mcp" },
    })
    expect((echo.result as { content: Array<{ text: string }>; structuredContent: { echoed: string } }).content[0]?.text).toContain("hello mcp")
    expect((echo.result as { structuredContent: { echoed: string } }).structuredContent.echoed).toBe("hello mcp")

    const resources = await server.request(4, "resources/list")
    expect((resources.result as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri)).toContain("sample://readme")

    const resource = await server.request(5, "resources/read", { uri: "sample://readme" })
    expect((resource.result as { contents: Array<{ text: string }> }).contents[0]?.text).toContain("EasyCode Local MCP Test Server")

    const prompt = await server.request(6, "prompts/get", {
      name: "summarize-change",
      arguments: { topic: "MCP smoke test" },
    })
    expect((prompt.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain("MCP smoke test")

    const ping = await server.request(7, "ping")
    expect(ping.result).toEqual({})
  })
})
