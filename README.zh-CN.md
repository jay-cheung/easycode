# easycode

基于 Bun 和 TypeScript 构建的轻量级、规格驱动编码代理。

## 语言版本

- [English](README.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md)
- [Deutsch](README.de.md)
- [Français](README.fr.md)

## 安装

```bash
bun install
```

把 provider 凭据写入 `.env`，也可以在 shell 中导出。shell 环境变量优先于 `.env`。

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro
```

## Providers

Provider 通过 `src/provider/registry.ts` 注册；agent、CLI、eval 都通过注册表创建 provider，不再硬编码判断。

内置 provider：

- `fake`：用于测试和 eval 的确定性本地 provider。
- `openai`：OpenAI Responses API provider。
- `deepseek`：DeepSeek Chat Completions provider，使用 `thinking`、`reasoning_effort: "high"` 和 `stream: false`。

## 使用

```bash
bun run src/cli.ts build --provider fake
bun run src/cli.ts plan --provider fake
bun run src/cli.ts build --provider openai
bun run src/cli.ts build --provider deepseek --logger
```

未开启 `--logger` 时，模型输出会流式写入 stdout。开启 `--logger` 时，模型文本会在 run 结束后一次性输出，避免和结构化日志混在一起。

使用 `--once` 可以执行单次 prompt，不进入交互式会话。

```bash
bun run src/cli.ts build --once "Fix the failing test" --provider fake
bun run src/cli.ts plan --once "Plan the smallest safe change" --provider fake
```

## 会话

交互式会话是默认模式，会将对话历史持久化到 `.easycode/sessions/`。不传 `--session` 时使用 `default` 会话；使用 `--session <id>` 可以选择具名会话。看到 `> ` 后再输入 prompt。

```bash
bun run src/cli.ts build --provider deepseek
bun run src/cli.ts build --provider deepseek --session demo
```

输入 `exit`、`:exit`、`quit` 或 `:quit` 退出。

## Skills

Skill 会从以下目录发现：

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

文件名大小写不敏感，`skill.md` 和 `SKILL.md` 都支持。上下文中默认只放 skill 的名称和描述，完整内容通过 `skill` tool 加载。

## Logger

```bash
bun run src/cli.ts build --provider deepseek --logger
```

Logger 行为：

- 网络请求和错误响应日志黄色高亮，`provider.request` 和 `provider.response` 只包含请求/响应 body。
- 状态转换日志青色高亮。
- 只有真正的 error 事件写入 stderr。
- Provider 失败会进入 `provider.output`，也会作为最终 failed result 返回给用户。

## 检查

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
