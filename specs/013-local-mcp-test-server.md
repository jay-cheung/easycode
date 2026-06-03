# Local MCP Test Server

## Goal

Provide a minimal local MCP server that can be launched from this repository to validate stdio-based MCP clients without depending on external services or changing EasyCode runtime behavior.

## Scope

- The server is a standalone development fixture under `dev/mcp/test-server.ts`.
- It speaks MCP over stdio using `Content-Length` framed JSON-RPC messages.
- It exposes a small fixed surface for smoke testing:
  - `initialize`
  - `ping`
  - `tools/list`
  - `tools/call`
  - `resources/list`
  - `resources/read`
  - `prompts/list`
  - `prompts/get`
- It does not integrate into EasyCode's own tool runtime. This is for client-side MCP validation only.

## Fixed Test Surface

### Tools

- `echo`
  - Input: `{ "text": string }`
  - Output: echoes the provided text and returns invocation count in `structuredContent`.
- `sum`
  - Input: `{ "a": number, "b": number }`
  - Output: returns numeric sum in text and structured content.
- `get_server_state`
  - Input: `{}`
  - Output: returns initialization state and aggregate counts for smoke debugging.

### Resources

- `sample://readme`
  - Markdown text resource for verifying list/read flows.
- `sample://config`
  - JSON text resource for verifying non-Markdown MIME handling.

### Prompts

- `summarize-change`
  - Required argument: `topic`
  - Returns one user message prompt for code-change summarization.

## Verification

- Integration smoke test should spawn the server as a subprocess and verify at least one successful round-trip for initialize, tool call, resource read, prompt get, and ping.
- The server should remain dependency-light and rely only on Bun/Node primitives already available in the repository.
