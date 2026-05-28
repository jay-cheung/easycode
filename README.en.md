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
/thinking on|off        enable or disable model thinking
/effort <level>         set effort: low, medium, high, max
/settings               show session settings
/sessions               list saved sessions
/cancel                 cancel the active run
```

## Retrieval Sources

Third-party context starts as read-only configuration so permission, citation, and logging behavior can be tested before live integrations are enabled.

```json
{
  "servers": [
    {
      "name": "docs",
      "resources": [
        { "uri": "doc://example", "title": "Example", "description": "short summary", "text": "full text" }
      ]
    }
  ]
}
```

Save this as `.easycode/mcp.json` and use `mcp_list_resources` or `mcp_read_resource`. Public web evidence can be saved to `.easycode/websearch.json`:

```json
{
  "results": [
    { "url": "https://example.com", "title": "Example", "snippet": "quoted summary", "retrievedAt": "2026-05-28T00:00:00.000Z" }
  ]
}
```

`web_search` reads fixtures by default and does not perform live network requests by default.

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
