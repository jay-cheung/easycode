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

## Providers

Providers are registered through `src/provider/registry.ts`; agent, CLI, and eval code create providers through that registry instead of hard-coded provider checks.

Built-in providers:

- `fake`: deterministic local provider for tests and evals.
- `openai`: OpenAI Responses API provider with image input and reasoning effort controls.
- `deepseek`: DeepSeek Chat Completions provider with `thinking`, `reasoning_effort`, and streaming enabled.

## Usage

```bash
bun run src/cli.ts build --provider fake
bun run src/cli.ts plan --provider fake
bun run src/cli.ts build --provider openai
bun run src/cli.ts build --provider deepseek --logger
```

Without `--logger`, EasyCode renders a lightweight timeline with model thinking, tool calls, tool results, and the final answer. With `--logger`, structured diagnostic logs are emitted instead of the timeline.

Use `--once` to run a single prompt without entering an interactive session.

```bash
bun run src/cli.ts build --once "Fix the failing test" --provider fake
bun run src/cli.ts plan --once "Plan the smallest safe change" --provider fake
```

## Sessions

Interactive session mode is the default and persists conversation history under `.easycode/sessions/`. Without `--session`, easycode uses the `default` session. Use `--session <id>` to select a named session. Enter prompts after the `> ` prompt appears.

```bash
bun run src/cli.ts build --provider deepseek
bun run src/cli.ts build --provider deepseek --session demo
```

Exit with `exit`, `:exit`, `quit`, or `:quit`.

## Slash Commands

Interactive sessions support a small command set:

```text
/image <path-or-url>    attach an image to the next prompt
/image clear            clear pending images
/skill list             list available skills
/skill use <name>       keep a skill active for this session
/skill clear            clear active skills
/model <provider> [id]  switch provider/model
/effort <level>         set thinking strength: low, medium, high, max
/thinking on|off        enable or disable model thinking
/settings               show current session settings
/help                   show command help
```

Image input is capability-gated. OpenAI Responses receives image parts directly; providers without vision support, such as DeepSeek, return a local error asking you to switch provider.

## Sandbox Recovery

On macOS, bash commands run with a native write sandbox that blocks writes outside the project root, and EasyCode also preflights explicit command paths so they stay inside the project. If either guard blocks a command, EasyCode prompts before retrying with the relevant guard bypassed. The retry still keeps dangerous-command checks. Native sandbox bypass may let the command write to temp, cache, or home directories outside the project; path-boundary bypass may let the command read from or reference paths outside the project.

Repeated bash and sandbox-bypass approvals are cached for the current session by reviewed scope. Simple read-only commands such as `ls` can reuse a narrow path scope like `readonly ls /tmp/work/*`; complex or side-effectful commands stay scoped to the exact command. The cache is in memory only and is not saved to session files.

## Skills

Skills are discovered from these roots:

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

Skill files are matched case-insensitively as `skill.md` / `SKILL.md`. Only skill names and descriptions are loaded into context up front; full content is loaded through the `skill` tool.

`/skill use <name>` makes a skill active for the current session and injects its full instructions into future requests. Active skill names are saved in `.easycode/sessions/`.

## Logger

```bash
bun run src/cli.ts build --provider deepseek --logger
```

Logger behavior:

- Network request and error response logs are highlighted in yellow. `provider.request` and `provider.response` only include the request/response body.
- State transition logs are highlighted in cyan.
- Only real error events are written to stderr.
- Provider failures are surfaced in `provider.output` and returned to the user as the final failed result text.

## Checks

```bash
bun test
bun run eval --provider fake
bun run typecheck
```

Real provider smoke tests are opt-in so the default test suite stays offline and deterministic:

```bash
EASYCODE_TEST_PROVIDER=deepseek bun run test:real
EASYCODE_TEST_PROVIDER=openai bun run test:real
```
