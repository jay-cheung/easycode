# EasyCode

[中文](README.md) | English

EasyCode is a command-line coding agent for real repositories. It focuses on reading code, planning changes, editing safely, running verification, and preserving useful context across sessions.

## Highlights

- **Plan and build modes**: `plan` is read-only; `build` can modify files after permission checks.
- **Repository-native workflow**: file reads, precise edits, patch operations, bash, Git status/diff/stage/commit, and code navigation tools.
- **Clear safety boundaries**: project-root write limits, dangerous command denial, sandbox recovery prompts, and basic secret redaction.
- **Long-running context**: saved sessions, compaction, project memory, and progressive skill loading.
- **Multiple providers**: built-in `openai`, `deepseek`, `openai-compatible`, and offline `fake`.
- **Verifiable quality**: offline tests, fake evals, APIx evals, cache benchmarks, and opt-in real-provider smoke tests.

## Install

Download the right binary from [GitHub Releases](https://github.com/FanFan-web-developer/easycode/releases) and place it on your `PATH`.

macOS arm64:

```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-darwin-arm64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

Check it:

```bash
easycode build --provider fake
```

Build from source:

```bash
git clone https://github.com/FanFan-web-developer/easycode.git
cd easycode
bun install
bun run build
```

## Configure

Create `.env` in the repository root, or export variables in your shell. Shell variables win over `.env`.

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro

OPENAI_COMPAT_API_KEY=...
OPENAI_COMPAT_API_URL=https://provider.example/v1/chat/completions
OPENAI_COMPAT_MODEL=provider-model
```

## Usage

Interactive:

```bash
easycode build --provider deepseek
easycode plan --provider deepseek
easycode build --provider deepseek --tui
```

Single prompt:

```bash
easycode build --once "Fix the failing test" --provider deepseek
easycode plan --once "Plan the smallest safe change" --provider deepseek
```

Run from source during development:

```bash
bun run src/cli.ts build --provider fake
bun run src/cli.ts plan --provider fake
bun run src/cli.ts build --provider fake --tui
```

## Common Commands

```text
/model <provider> [id]  switch provider or model
/image <path-or-url>    attach an image to the next prompt
/skill list             list available skills
/skill use <name>       enable a skill
/skill remove <name>    remove an enabled skill
/thinking on|off        enable or disable model thinking
/effort <level>         set effort: low, medium, high, max
/settings               show session settings
/sessions               list saved sessions
/cancel                 cancel the active run
```

## Data Source Configuration

Data sources provide extra context (docs, code standards, search results, common commands) to the AI. They are configured as read-only JSON files under `.easycode/` in your project root. **No restart is required** — changes take effect immediately.

---

### MCP (Structured Knowledge Sources)

`.easycode/mcp.json` — Bundle frequently-used documentation, architecture notes, or specs into structured resources for on-demand reference during conversations.

```json
{
  "servers": [
    {
      "name": "docs",
      "resources": [
        { "uri": "doc://api-guide", "title": "API Guide", "description": "Project API usage", "text": "Full documentation text..." }
      ]
    }
  ]
}
```

Available tools:
- **mcp_list_resources** — list all configured MCP resources
- **mcp_read_resource** — read a resource by uri and server

---

### Web Search (Live Search + Fixtures)

`.easycode/websearch.json` supports two modes:

- Set `defaultEngine`, or pass `engine` to the tool: run live search.
- Omit search engines, or pass `live: false`: read local `results` fixtures for deterministic tests.
- If `.easycode/websearch.json` is absent but `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` (or `GOOGLE_SEARCH_ENGINE_ID`) are present in the environment, runtime falls back to `google` as the default live engine.

Google Programmable Search example:

```json
{
  "defaultEngine": "google",
  "engines": [
    {
      "name": "google",
      "type": "google",
      "apiKeyEnv": "GOOGLE_SEARCH_API_KEY",
      "extraParams": {
        "cx": "your-programmable-search-engine-id",
        "hl": "en"
      }
    }
  ],
  "results": [
    { "url": "https://example.com", "title": "Example", "snippet": "Quoted summary", "retrievedAt": "2026-05-28T00:00:00.000Z" }
  ]
}
```

The built-in `google` engine uses the Google Programmable Search JSON API and requires `extraParams.cx`.

Brave Search example:

```json
{
  "defaultEngine": "brave",
  "engines": [
    {
      "name": "brave",
      "type": "brave",
      "apiKeyEnv": "BRAVE_SEARCH_API_KEY",
      "extraParams": { "country": "US" }
    }
  ]
}
```

Tavily example:

```json
{
  "defaultEngine": "tavily",
  "engines": [
    {
      "name": "tavily",
      "type": "tavily",
      "apiKeyEnv": "TAVILY_API_KEY",
      "extraParams": { "search_depth": "basic", "topic": "general" }
    }
  ]
}
```

Custom JSON search engine example:

```json
{
  "engines": [
    {
      "name": "internal-search",
      "type": "custom",
      "endpoint": "https://search.example.com/query",
      "method": "POST",
      "apiKeyEnv": "INTERNAL_SEARCH_TOKEN",
      "apiKeyHeader": "X-API-Key",
      "queryParam": "text",
      "limitParam": "size",
      "resultsPath": "data.items",
      "titlePath": "headline",
      "urlPath": "link",
      "snippetPath": "summary",
      "sourcePath": "publisher"
    }
  ]
}
```

`web_search` parameters: `query`, `limit`, `engine`, and `live`. Prefer environment variables for API keys instead of committing secrets.

---

### Connector (Local Command Wrappers)

`.easycode/connectors.json` — Wrap common shell commands as tools that can be invoked during conversation. Each execution requires approval.

```json
{
  "tools": [
    {
      "name": "lint",
      "description": "Run linter to check code",
      "command": "bun run lint"
    },
    {
      "name": "test",
      "description": "Run tests",
      "command": "bun test"
    }
  ]
}
```

Available tools:
- **connector_list** — list all configured connectors
- **connector_call <name>** — execute the specified shell command

---

### Skill (Behavior Instruction Injection)

Skills are markdown files searched in the following order (later directories override earlier ones):

| Search path | Scope |
|---|---|
| `.agent/skills/` | Project |
| `.easycode/skills/` | Project |
| `~/.agent/skills/` | User global |
| `~/.easycode/skills/` | User global |

Each skill file follows this format (file name is arbitrary, subdirectories supported):

```markdown
---
name: code-review
description: Code review rules and best practices
---

## Review principles

- Prefer maintainability over micro-optimizations
- ...
```

Manage skills at runtime with slash commands:
- `/skill list` — list all available skills
- `/skill use code-review` — enable a skill for this session
- `/skill remove code-review` — remove an enabled skill
- `/skill clear` — disable all skills

When enabled, the full skill content is injected into the conversation context, influencing the model's response style and rule adherence.

## CLI Commands & Configuration

### Main Commands

| Command | Description |
|---|---|
| `easycode build [options]` | Build mode: analyze → edit → verify |
| `easycode plan [options]` | Plan mode: read-only analysis, output plan, no file changes |

### CLI Options

| Option | Description |
|---|---|
| `--once <prompt>` | Single task mode, exits after completion |
| `--provider <name>` | Specify AI provider (see list below) |
| `--model <id>` | Specify model ID (overrides provider default) |
| `--max-tokens <n>` | Max tokens per API call (default 32000) |
| `--max-steps <n>` | Max execution steps (default 66) |
| `--root <path>` | Project root directory (default: current dir) |
| `--session <id>` | Load a specific session |
| `--logger` | Output detailed logs |
| `--tui` | Start TUI interactive interface |

**Examples:**
```bash
easycode build --provider deepseek
easycode plan --once "Analyze project structure" --provider openai
easycode build --provider deepseek --tui
easycode build --once "Fix failing tests" --provider openai --max-steps 20
```

### Interactive Slash Commands

Type `/` in interactive mode:

| Command | Description |
|---|---|
| `/model <provider> [id]` | Switch provider or model |
| `/image <path-or-url>` | Attach an image to the next prompt |
| `/image clear` | Clear pending images |
| `/skill list` | List available skills |
| `/skill use <name>` | Enable a skill |
| `/skill remove <name>` | Remove an enabled skill |
| `/skill clear` | Disable all skills |
| `/thinking on\|off` | Enable or disable model thinking |
| `/effort <level>` | Set effort: `low`, `medium`, `high`, `max` |
| `/settings` | Show current session settings |
| `/sessions` | List saved sessions |
| `//text` | Send `/text` as a normal prompt |

### Environment Variables / `.env`

Configure credentials in `.env` at the project root, or via shell environment variables (shell takes precedence).

```env
# Provider selection (fallback if --provider not set)
EASYCODE_PROVIDER=deepseek

# OpenAI
OPENAI_API_KEY=sk-...
# Default model: gpt-4o

# DeepSeek
DEEPSEEK_API_KEY=sk-...
# Default model: deepseek-chat

# OpenAI-Compatible
OPENAI_COMPAT_API_KEY=sk-...
OPENAI_COMPAT_API_URL=https://your-provider.example/v1/chat/completions
OPENAI_COMPAT_MODEL=your-model
```

### Available Providers

| Provider | Description |
|---|---|
| `openai` | OpenAI API (default model gpt-4o) |
| `deepseek` | DeepSeek API (default model deepseek-chat) |
| `openai-compatible` | Any OpenAI-compatible API |
| `fake` | Offline simulation (testing/development) |
| `simulated` | Same as fake, simulation mode |

## Verify

```bash
bun run verify:v1
bun test
bun run eval --provider fake
bun run apix:eval --provider simulated --table
bun run cache:bench -- --provider simulated --suite real --quiet
```

Real-provider checks are opt-in:

```bash
EASYCODE_TEST_PROVIDER=deepseek bun run test:real
EASYCODE_TEST_PROVIDER=openai bun run test:real
EASYCODE_TEST_PROVIDER=deepseek bun run eval:real
EASYCODE_TEST_PROVIDER=openai bun run apix:real
```
