# easycode

Lightweight specs-driven coding agent built with Bun and TypeScript.

## Translations

- [中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md)
- [Deutsch](README.de.md)
- [Français](README.fr.md)

## Setup

```bash
bun install
```

Put provider credentials in `.env` or export them in the shell. Shell variables win over `.env` values.

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro
```

Optional provider endpoint overrides:

```env
OPENAI_API_URL=https://api.openai.com/v1/responses
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
```

## Providers

Providers are registered through `src/provider/registry.ts`; agent, CLI, and eval code create providers through that registry instead of hard-coded provider checks.

Built-in providers:

- `fake`: deterministic local provider for tests and evals.
- `openai`: OpenAI Responses API provider.
- `deepseek`: DeepSeek Chat Completions provider with `thinking: { type: "enabled" }`, `reasoning_effort: "high"`, and `stream: false`.

## Usage

Run a one-shot build task:

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
```

Run a planning task:

```bash
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
```

Use OpenAI:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
```

Use DeepSeek:

```bash
bun run src/cli.ts build "我当前有什么可用的skill" --provider deepseek --logger
```

Without `--logger`, model text is streamed to stdout as it arrives. With `--logger`, model text is printed after the run completes so structured logs do not mix with the response.

## Sessions

Use `--session <id>` to persist conversation history under `.easycode/sessions/`.

Single turn with persistence:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --session demo
```

Interactive session:

```bash
bun run src/cli.ts build --provider deepseek --session demo
```

Exit with `exit`, `:exit`, `quit`, or `:quit`.

## Skills

Skills are discovered from these roots:

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

Skill files are matched case-insensitively as `skill.md` / `SKILL.md`. Only skill names and descriptions are loaded into context up front; full content is loaded through the `skill` tool.

## Logger

Enable structured execution logs with `--logger`:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider deepseek --logger
```

Logger behavior:

- Network logs `provider.request`, `provider.response`, and `provider.response.raw` are highlighted in yellow.
- State transition logs are highlighted in cyan.
- Only real error events are written to stderr.
- Provider failures are surfaced in `provider.output` and returned to the user as the final failed result text.

## Checks

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
