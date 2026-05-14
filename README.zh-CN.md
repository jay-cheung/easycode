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
- `openai`：OpenAI Responses API provider，支持图片输入和 reasoning effort 控制。
- `deepseek`：DeepSeek Chat Completions provider，支持 `thinking`、`reasoning_effort` 和流式输出。

## 使用

```bash
bun run src/cli.ts build --provider fake
bun run src/cli.ts plan --provider fake
bun run src/cli.ts build --provider openai
bun run src/cli.ts build --provider deepseek --logger
```

未开启 `--logger` 时，EasyCode 会渲染轻量时间线，展示模型 thinking、工具调用、工具结果和最终回复。开启 `--logger` 时输出结构化诊断日志，不启用时间线。

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

## Slash Commands

交互式会话支持以下命令：

```text
/image <path-or-url>    将图片附加到下一轮 prompt
/image clear            清空待发送图片
/skill list             列出可用 skill
/skill use <name>       在当前 session 启用某个 skill
/skill clear            清空启用的 skill
/model <provider> [id]  切换 provider/model
/effort <level>         设置思考强度：low、medium、high、max
/thinking on|off        开启或关闭模型 thinking
/settings               查看当前 session 设置
/help                   查看命令帮助
```

图片输入会按 provider capability 门控。OpenAI Responses 会直接收到图片 part；DeepSeek 等不支持 vision 的 provider 会在本地报错并提示切换 provider。

## Sandbox 恢复

在 macOS 上，bash 命令会通过 native write sandbox 运行，默认禁止写入项目根目录之外的位置；EasyCode 也会预检查命令中的显式路径，默认要求它们留在项目内。如果任一保护拦住命令，EasyCode 会先提示风险，再询问是否绕过对应保护重试。重试仍保留危险命令检查。绕过 native sandbox 后，命令可能写入项目外的临时目录、缓存目录或用户目录；绕过路径边界后，命令可能读取或引用项目外路径。

## Skills

Skill 会从以下目录发现：

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

文件名大小写不敏感，`skill.md` 和 `SKILL.md` 都支持。上下文中默认只放 skill 的名称和描述，完整内容通过 `skill` tool 加载。

`/skill use <name>` 会在当前 session 启用 skill，并把完整指令注入后续请求。启用的 skill 名称会保存到 `.easycode/sessions/`。

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

真实 provider smoke test 默认不运行，以保持测试离线且确定性；需要时显式启用：

```bash
EASYCODE_TEST_PROVIDER=deepseek bun run test:real
EASYCODE_TEST_PROVIDER=openai bun run test:real
```
