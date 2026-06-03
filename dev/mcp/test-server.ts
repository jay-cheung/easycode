import process from "node:process"

type JsonRpcId = string | number | null

type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: JsonRpcId
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

const SERVER_INFO = {
  name: "easycode-local-test-mcp",
  version: "0.1.0",
} as const

const PROTOCOL_VERSION = "2024-11-05"

const resources = [
  {
    uri: "sample://readme",
    name: "Local MCP README",
    description: "Static text resource exposed by the local MCP test server.",
    mimeType: "text/markdown",
    text: [
      "# EasyCode Local MCP Test Server",
      "",
      "This resource is served over MCP stdio for local client validation.",
      "Use it to verify resource listing, reading, and citation plumbing.",
    ].join("\n"),
  },
  {
    uri: "sample://config",
    name: "Sample Config",
    description: "JSON-shaped sample configuration for fixture-style reads.",
    mimeType: "application/json",
    text: JSON.stringify(
      {
        provider: "fake",
        mode: "build",
        features: ["tools", "resources", "prompts"],
      },
      null,
      2,
    ),
  },
] as const

const prompts = [
  {
    name: "summarize-change",
    description: "Generate a short summary prompt for a code change.",
    arguments: [
      {
        name: "topic",
        description: "The feature or bugfix to summarize.",
        required: true,
      },
    ],
  },
] as const

let initialized = false
let toolCallCount = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for ${field}`)
  }
  return value
}

function asNumber(value: unknown, field: string) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected number for ${field}`)
  }
  return value
}

function writeMessage(message: JsonRpcResponse) {
  const body = JSON.stringify(message)
  const bytes = Buffer.byteLength(body, "utf8")
  process.stdout.write(`Content-Length: ${bytes}\r\nContent-Type: application/json\r\n\r\n${body}`)
}

function writeResult(id: JsonRpcId, result: unknown) {
  writeMessage({ jsonrpc: "2.0", id, result })
}

function writeError(id: JsonRpcId, error: JsonRpcError) {
  writeMessage({ jsonrpc: "2.0", id, error })
}

function makeToolList() {
  return {
    tools: [
      {
        name: "echo",
        description: "Echo a string payload and count tool invocations.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to echo back.",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      {
        name: "sum",
        description: "Return the sum of two numeric inputs.",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
      {
        name: "get_server_state",
        description: "Return current test-server state for protocol debugging.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }
}

function callTool(params: unknown) {
  if (!isRecord(params)) {
    throw new Error("Expected object params for tools/call")
  }
  const name = asString(params.name, "name")
  const args = isRecord(params.arguments) ? params.arguments : {}
  toolCallCount += 1

  switch (name) {
    case "echo": {
      const text = asString(args.text, "arguments.text")
      return {
        content: [{ type: "text", text: `echo(${toolCallCount}): ${text}` }],
        structuredContent: {
          echoed: text,
          toolCallCount,
        },
      }
    }
    case "sum": {
      const a = asNumber(args.a, "arguments.a")
      const b = asNumber(args.b, "arguments.b")
      return {
        content: [{ type: "text", text: `${a} + ${b} = ${a + b}` }],
        structuredContent: {
          a,
          b,
          total: a + b,
          toolCallCount,
        },
      }
    }
    case "get_server_state":
      return {
        content: [{ type: "text", text: `initialized=${initialized}, toolCallCount=${toolCallCount}` }],
        structuredContent: {
          initialized,
          toolCallCount,
          resourceCount: resources.length,
          promptCount: prompts.length,
        },
      }
    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      }
  }
}

function readResource(params: unknown) {
  if (!isRecord(params)) {
    throw new Error("Expected object params for resources/read")
  }
  const uri = asString(params.uri, "uri")
  const resource = resources.find((item) => item.uri === uri)
  if (!resource) {
    throw new Error(`Unknown resource: ${uri}`)
  }
  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.text,
      },
    ],
  }
}

function getPrompt(params: unknown) {
  if (!isRecord(params)) {
    throw new Error("Expected object params for prompts/get")
  }
  const name = asString(params.name, "name")
  if (name !== "summarize-change") {
    throw new Error(`Unknown prompt: ${name}`)
  }
  const args = isRecord(params.arguments) ? params.arguments : {}
  const topic = asString(args.topic, "arguments.topic")
  return {
    description: "Prompt template for summarizing a small code change.",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Summarize the code change for "${topic}" in 3 bullet points with risk notes.`,
        },
      },
    ],
  }
}

async function handleRequest(message: JsonRpcRequest) {
  if (message.method === "notifications/initialized") {
    initialized = true
    return
  }

  const id = message.id ?? null
  if (message.id === undefined) {
    return
  }

  try {
    switch (message.method) {
      case "initialize":
        writeResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: SERVER_INFO,
          instructions: "Use this local MCP server to test stdio initialization, tools, resources, and prompts.",
        })
        return
      case "ping":
        writeResult(id, {})
        return
      case "tools/list":
        writeResult(id, makeToolList())
        return
      case "tools/call":
        writeResult(id, callTool(message.params))
        return
      case "resources/list":
        writeResult(id, {
          resources: resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
        })
        return
      case "resources/read":
        writeResult(id, readResource(message.params))
        return
      case "resources/templates/list":
        writeResult(id, { resourceTemplates: [] })
        return
      case "prompts/list":
        writeResult(id, { prompts })
        return
      case "prompts/get":
        writeResult(id, getPrompt(message.params))
        return
      case "logging/setLevel":
        writeResult(id, {})
        return
      default:
        writeError(id, { code: -32601, message: `Method not found: ${message.method}` })
        return
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Unknown error"
    writeError(id, { code: -32602, message: messageText })
  }
}

class StdioMessageParser {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.tryParseOne()) {
      continue
    }
  }

  private tryParseOne() {
    const headerEnd = this.buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return false

    const headerText = this.buffer.subarray(0, headerEnd).toString("utf8")
    const headers = headerText.split("\r\n")
    const contentLengthHeader = headers.find((line) => line.toLowerCase().startsWith("content-length:"))
    if (!contentLengthHeader) {
      throw new Error("Missing Content-Length header")
    }

    const rawLength = contentLengthHeader.slice("content-length:".length).trim()
    const contentLength = Number.parseInt(rawLength, 10)
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error(`Invalid Content-Length: ${rawLength}`)
    }

    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength
    if (this.buffer.length < bodyEnd) return false

    const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")
    this.buffer = this.buffer.subarray(bodyEnd)
    void handleRequest(JSON.parse(body) as JsonRpcRequest)
    return true
  }
}

const parser = new StdioMessageParser()

process.stdin.on("data", (chunk: Buffer) => {
  parser.push(chunk)
})

process.stdin.on("error", (error) => {
  process.stderr.write(`stdin error: ${error.message}\n`)
})

process.on("SIGINT", () => {
  process.exit(0)
})

process.stdin.resume()
