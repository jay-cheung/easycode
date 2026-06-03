# EasyCode

中文 / English

EasyCode 是一个面向真实代码仓库的命令行 Coding Agent。它专注于"读代码、做计划、改代码、跑验证、保留上下文"，适合在本地仓库里完成日常修 bug、重构、测试修复和代码探索。

EasyCode is a command-line coding agent for real repositories. It focuses on reading code, planning changes, editing safely, running verification, and preserving useful context across sessions.

## 项目亮点 / Highlights

- **计划 / 执行分离**：`plan` 模式只读分析并输出方案，`build` 模式才允许修改文件。
  **Plan and build modes**: `plan` is read-only; `build` can modify files after permission checks.
- **真实仓库工作流**：内置文件读取、精确编辑、patch、bash、Git diff/status/stage/commit、代码导航等工具。
  **Repository-native workflow**: file reads, precise edits, patch operations, bash, Git status/diff/stage/commit, and code navigation tools.
- **安全边界明确**：默认限制写入项目外路径，危险命令会被拒绝，敏感输出会做基础脱敏。
  **Clear safety boundaries**: project-root write limits, dangerous command denial, sandbox recovery prompts, and basic secret redaction.
- **长上下文可持续**：支持会话保存、上下文压缩、项目记忆和技能按需加载。
  **Long-running context**: saved sessions, compaction, project memory, and progressive skill loading.
- **多 Provider 支持**：内置 `openai`、`deepseek`、`openai-compatible` 和离线测试用 `fake`。
  **Multiple providers**: built-in `openai`, `deepseek`, `openai-compatible`, and offline `fake`.
- **可验证质量**：提供离线测试、fake eval、APIx eval、cache benchmark 和真实 provider smoke test。
  **Verifiable quality**: offline tests, fake evals, APIx evals, cache benchmarks, and opt-in real-provider smoke tests.

## 安装 / Install

从 [GitHub Releases](https://github.com/FanFan-web-developer/easycode/releases) 下载对应平台二进制并放入 `PATH`。

Download the right binary from [GitHub Releases](https://github.com/FanFan-web-developer/easycode/releases) and place it on your `PATH`.

macOS arm64 示例 / macOS arm64:

```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-darwin-arm64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

验证安装 / Check it:

```bash
easycode build --provider fake
```

从源码构建 / Build from source:

```bash
git clone https://github.com/FanFan-web-developer/easycode.git
cd easycode
bun install
bun run build
```

### DeepSeek 配置示例 / DeepSeek Configuration Example

DeepSeek 是 EasyCode 的**默认 provider**，支持 thinking / reasoning effort。如果只使用 DeepSeek，连 `--provider` 都不需要指定。

DeepSeek is the **default provider** in EasyCode. It supports thinking and reasoning effort. If you only use DeepSeek, you don't even need `--provider`.

#### 最小配置 / Minimal Setup

```env
DEEPSEEK_API_KEY=sk-xxx
```

然后用默认启动即可 / Then start with defaults:

```bash
easycode build      # 自动使用 deepseek 和默认模型 / automatically uses deepseek and default model
easycode plan
```

#### 完整配置 / Full Configuration

```env
# === 必填 / Required ===
DEEPSEEK_API_KEY=sk-xxx

# === 模型（优先级从高到低） / Model (priority high to low) ===
# 1. CLI --model flag
# 2. DEEPSEEK_MODEL env var
# 3. EASYCODE_MODEL env var (global fallback)
# 4. Built-in default deepseek-v4-pro
DEEPSEEK_MODEL=deepseek-v4-pro

# === API 地址（默认 https://api.deepseek.com/chat/completions）===
# === API URL (default https://api.deepseek.com/chat/completions) ===
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions

# === 思考强度（high 或 max，默认 max）===
# === Reasoning effort (high or max, default max) ===
DEEPSEEK_REASONING_EFFORT=max

# === 上下文窗口（默认由模型决定）===
# === Context window (default determined by model) ===
# DEEPSEEK_CONTEXT_WINDOW_TOKENS=65536

# === Prompt 缓存最小前缀 token 数（自动缓存时有效）===
# === Prompt cache min prefix tokens (effective when auto-caching) ===
# DEEPSEEK_PROMPT_CACHE_MIN_PREFIX_TOKENS=1024
```

#### 常用启动方式 / Common Startup

```bash
# 默认 DeepSeek 启动 / Default DeepSeek startup
easycode build

# 显式指定 provider / Explicit provider
easycode build --provider deepseek
easycode plan --provider deepseek

# 覆盖模型 / Override model
easycode build --model deepseek-chat
easycode plan --model deepseek-chat
```

## 使用 / Usage

交互式执行 / Interactive:

```bash
easycode build --provider deepseek
easycode plan --provider deepseek
easycode build --provider deepseek --tui
```

单次任务 / Single task:

```bash
easycode build --once "修复失败的测试" --provider deepseek
easycode plan --once "给出最小安全改动方案" --provider deepseek

easycode build --once "Fix failing tests" --provider deepseek
easycode plan --once "Propose minimal safe changes" --provider deepseek
```

本地开发时也可以直接用 Bun 运行源码 / Run directly with Bun during development:

```bash
bun run src/cli.ts build --provider fake
bun run src/cli.ts plan --provider fake
bun run src/cli.ts build --provider fake --tui
```

## 本地 MCP 测试服务 / Local MCP Test Server

仓库内置了一个最小的本地 MCP stdio server，用来验证 MCP client 的初始化、工具调用、资源读取和 prompt 拉取，不依赖外部服务，也不会改动 EasyCode 运行时。

This repository includes a minimal local MCP stdio server for validating MCP client initialization, tool calls, resource reads, and prompt retrieval without external services or runtime integration work.

启动方式 / Start it:

```bash
bun run mcp:test:server
```

它支持的最小 MCP surface / Exposed surface:

- `initialize`
- `ping`
- `tools/list`
- `tools/call` (`echo`, `sum`, `get_server_state`)
- `resources/list`
- `resources/read` (`sample://readme`, `sample://config`)
- `prompts/list`
- `prompts/get` (`summarize-change`)

示例 client 配置 / Example client config:

```json
{
  "mcpServers": {
    "easycode-local-test": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/easycode/dev/mcp/test-server.ts"]
    }
  }
}
```

如果只想验证这个 fixture 本身，可以直接跑仓库里的 smoke test / To validate the fixture itself:

```bash
bun test test/integration/mcp-test-server.test.ts
```

## 数据源配置 / Data Sources

数据源为 AI 提供额外的上下文（文档、代码规范、搜索结果、常用命令），以只读 JSON 文件配置在项目 `.easycode/` 目录下，**无需重启进程**即可生效。

Data sources provide AI with extra context (docs, code conventions, search results, common commands). Configure read-only JSON files under `.easycode/` — they take effect **without restarting the process**.

### MCP（结构化知识源 / Structured Knowledge）

`.easycode/mcp.json` —— 将常用文档、架构说明等预配为结构化条目，供对话中引用。

`.easycode/mcp.json` — Preconfigure structured entries like docs and architecture notes for reference during conversation.

```json
{
  "servers": [
    {
      "name": "docs",
      "resources": [
        { "uri": "doc://api-guide", "title": "API 指南 / API Guide", "description": "项目 API 使用说明 / Project API usage", "text": "..." }
      ]
    }
  ]
}
```

保存后可用以下工具 / Available tools after saving:

- **mcp_list_resources** — 列出所有配置的 MCP 资源 / list all configured MCP resources
- **mcp_read_resource** — 按 uri 和 server 读取某条资源正文 / read a resource by uri and server

### Web Search（Tavily + 本地 fixture / Local fixture）

`.easycode/websearch.json` 支持两种模式 / supports two modes:

- 配置 Tavily 或调用工具时传 `engine: "tavily"`：发起真实搜索。
  Configure Tavily, or pass `engine: "tavily"` to the tool: run live search.
- 不配置搜索引擎或显式 `live: false`：读取本地 `results` fixture，便于离线测试。
  Omit search engines, or pass `live: false`: read local `results` fixtures for deterministic tests.
- 如果未配置 `.easycode/websearch.json`，但环境里存在 `TAVILY_API_KEY`，运行时会自动使用 `tavily` 作为默认 live 引擎。
  If `.easycode/websearch.json` is absent but `TAVILY_API_KEY` is present in the environment, runtime falls back to `tavily` as the default live engine.
- 交互式会话启动时，如果未配置 Tavily，CLI 会优先提示把 `TAVILY_API_KEY` 写入全局 `~/.easycode/.env`；如果跳过，仍会保留后续提示。
  Interactive startup first offers to save `TAVILY_API_KEY` into global `~/.easycode/.env`; if skipped, the later reminder still appears.

推荐优先配置到全局 `~/.easycode/.env` / Recommended global `~/.easycode/.env`:

```dotenv
TAVILY_API_KEY=tvly-...
```

Tavily 示例 / Tavily example:

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

`web_search` 参数 / parameters: `query`、`limit`、`engine`、`live`。API key 建议只通过环境变量提供，不要写入仓库。
Prefer environment variables for API keys instead of committing secrets.

### Connector（本地命令封装 / Local Command Wrappers）

`.easycode/connectors.json` —— 把常用 shell 命令封装为工具，在对话中按需调用，每次执行需授权。

`.easycode/connectors.json` — Wrap common shell commands as tools that can be invoked during conversation. Each execution requires approval.

```json
{
  "tools": [
    {
      "name": "lint",
      "description": "运行 linter 检查代码 / Run linter to check code",
      "command": "bun run lint"
    },
    {
      "name": "test",
      "description": "运行测试 / Run tests",
      "command": "bun test"
    }
  ]
}
```

保存后可用以下工具 / Available tools:

- **connector_list** — 列出所有可用的 connector / list all configured connectors
- **connector_call \<name\>** — 执行指定的 shell 命令 / execute the specified shell command

### Skill（行为指令注入 / Behavior Instruction Injection）

Skill 是 markdown 文件，按以下优先级搜索（同名后面的覆盖前面的）：

Skills are markdown files searched in the following order (later directories override earlier ones):


| 搜索目录 / Search path | 范围 / Scope           |
| ---------------------- | ---------------------- |
| `.agent/skills/`       | 项目级 / Project       |
| `.easycode/skills/`    | 项目级 / Project       |
| `~/.agent/skills/`     | 用户全局 / User global |
| `~/.easycode/skills/`  | 用户全局 / User global |

每个 skill 文件格式如下（文件名为任意名称，支持子目录）：

Each skill file follows this format (file name is arbitrary, subdirectories supported):

```markdown
---
name: code-review
description: 代码审查规则和最佳实践 / Code review rules and best practices
---

## 审查原则 / Review principles

- 关注可维护性 > 性能优化 / Prefer maintainability over micro-optimizations
- ...
```

保存后在交互模式下通过 slash 命令管理 / Manage at runtime with slash commands:

- `/skill list` — 列出所有可用 skill / list all available skills
- `/skill use code-review` — 在当前会话启用 skill / enable a skill for this session
- `/skill remove code-review` — 移除已启用的 skill / remove an enabled skill
- `/skill clear` — 清空所有已启用 skill / disable all skills

启用后，skill 完整内容注入到对话上下文中，影响模型的回复风格和规则遵循。
When enabled, the full skill content is injected into the conversation context, influencing the model's response style and rule adherence.

## CLI 命令与配置 / CLI Commands & Configuration

### 主命令 / Main Commands


| 命令 / Command             | 用途 / Description                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `easycode build [options]` | 执行模式：分析 → 改代码 → 验证 / Build mode: analyze → edit → verify                               |
| `easycode plan [options]`  | 计划模式：只读分析，输出方案，不修改文件 / Plan mode: read-only analysis, output plan, no file changes |

### 命令行选项 / CLI Options


| 选项 / Option       | 说明 / Description                                                                    |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--once <prompt>`   | 单次任务模式，执行完成后退出 / Single task mode, exits after completion               |
| `--provider <name>` | 指定 AI provider（见下方列表） / Specify AI provider (see list below)                 |
| `--model <id>`      | 指定模型 ID（覆盖 provider 默认模型） / Specify model ID (overrides provider default) |
| `--max-tokens <n>`  | 每次 API 调用的最大 token 数（默认 32000） / Max tokens per API call (default 32000)  |
| `--max-steps <n>`   | 最大执行步数（默认 66） / Max execution steps (default 66)                            |
| `--root <path>`     | 项目根目录（默认当前目录） / Project root directory (default: current dir)            |
| `--session <id>`    | 加载指定 session / Load a specific session                                            |
| `--logger`          | 输出详细日志 / Output detailed logs                                                   |
| `--tui`             | 启动 TUI 交互界面 / Start TUI interactive interface                                   |

**示例 / Examples:**

```bash
easycode build --provider deepseek
easycode plan --once "分析项目结构" --provider openai
easycode plan --once "Analyze project structure" --provider openai
easycode build --provider deepseek --tui
easycode build --once "修复失败的测试" --provider openai --max-steps 20
easycode build --once "Fix failing tests" --provider openai --max-steps 20
```

### 交互式 Slash 命令 / Interactive Slash Commands

在交互模式下通过 `/` 前缀调用 / Type `/` in interactive mode:


| 命令 / Command           | 功能 / Description                                               |
| ------------------------ | ---------------------------------------------------------------- |
| `/model <provider> [id]` | 切换 provider 或模型 / Switch provider or model                  |
| `/image <path-or-url>`   | 给下一轮 prompt 附加图片 / Attach an image to the next prompt    |
| `/image clear`           | 清除待发送图片 / Clear pending images                            |
| `/skill list`            | 列出可用技能 / List available skills                             |
| `/skill use <name>`      | 启用指定技能 / Enable a skill                                    |
| `/skill remove <name>`   | 移除已启用的技能 / Remove an enabled skill                       |
| `/skill clear`           | 清空所有已启用技能 / Disable all skills                          |
| `/thinking on|off`       | 开启或关闭模型 thinking / Enable or disable model thinking       |
| `/effort <level>`        | 设置思考强度：`low`、`medium`、`high`、`max` / Set effort        |
| `/settings`              | 查看当前会话设置 / Show current session settings                 |
| `/sessions`              | 查看已保存会话 / List saved sessions                             |
| `//text`                 | 将`/text` 作为普通 prompt 发送 / Send `/text` as a normal prompt |

### 环境变量 / Environment Variables

在项目根目录创建 `.env`，或直接通过 shell 环境变量提供凭据。shell 环境变量优先级更高。

Create `.env` in the repository root, or export variables in your shell. Shell variables win over `.env`.

```env
# Provider 选择（--provider 未指定时兜底）/ Provider selection (fallback if --provider not set)
EASYCODE_PROVIDER=deepseek

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
# 启动向导回退预设 / Startup fallback presets: gpt-5.5, gpt-5.4

# DeepSeek
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-pro
# 启动向导回退预设 / Startup fallback presets: deepseek-v4-pro, deepseek-v4-flash

# OpenAI-Compatible
OPENAI_COMPAT_API_KEY=sk-...
OPENAI_COMPAT_API_URL=https://your-provider.example/v1/chat/completions
OPENAI_COMPAT_MODEL=your-model
```

### 可用 Provider / Available Providers


| Provider 名称 / Provider | 说明 / Description                                                   |
| ------------------------ | -------------------------------------------------------------------- |
| `openai`                 | OpenAI API（默认模型 gpt-5-mini；启动向导优先列最新 GPT 版本 / default model gpt-5-mini; setup prefers latest GPT versions） |
| `deepseek`               | DeepSeek API（默认模型 deepseek-v4-pro / default model deepseek-v4-pro） |
| `openai-compatible`      | 任何 OpenAI 兼容接口 / Any OpenAI-compatible API                     |
| `fake`                   | 离线模拟（测试/开发用）/ Offline simulation (testing/development)    |
| `simulated`              | 同 fake，模拟模式 / Same as fake, simulation mode                    |

## 验证 / Verify

```bash
bun run gate
bun run verify:v1
bun run verify:full
```

统一 gate 分层如下 / Unified gate hierarchy:

- `bun run gate` / `bun run verify:v1`：日常开发 gate。依次跑 `typecheck`、`bun test`、`fake eval`、经过校准的本地 `APIx` hard-gate 子集、`cache benchmark`。每次新需求开发完成后默认需要通过这一层。
  Daily dev gate. Runs `typecheck`, `bun test`, `fake eval`, calibrated local `APIx` hard-gate subset, `cache benchmark`. Must pass after each feature development.
- `bun run verify:full`：更重的本地 gate。在开发 gate 基础上追加 `build`；当前默认仍使用同一组稳定 APIx gate 用例，完整数据集继续保留给单独的 `apix:eval` 做能力盘点。
  Heavier local gate. Adds `build` on top of dev gate; uses the same stable APIx gate cases, with full dataset reserved for `apix:eval`.
- `bun run verify:provider -- --provider <name>`：真实 provider 就绪性 gate，会串起 smoke eval、APIx 子集、cache benchmark，并把报告写到 `.easycode/reports/quality-gate`。
  Real-provider readiness gate. Chains smoke eval, APIx subset, cache benchmark, writes report to `.easycode/reports/quality-gate`.
- 不带 `--provider` 的 `bun run provider:gate` 默认检查 `deepseek`、`openai`、`openai-compatible`；缺少凭证时会记录为 `skipped`。
  `bun run provider:gate` without `--provider` checks `deepseek`, `openai`, and `openai-compatible` by default; missing credentials are recorded as `skipped`.
- 首次交互式配置 `deepseek` 或 `openai` 时，CLI 会优先调用各自官方 `GET /models` API 取最新可用模型，并只展示最近两个版本；如果请求失败，则回退到内置候选。仍然支持直接输入自定义 model。
  During first-time interactive setup for `deepseek` or `openai`, the CLI first calls each provider's official `GET /models` API, keeps only the two most recent versions, and falls back to bundled presets on failure. Custom model input is still supported.

如果只想单独跑某一类验证 / Run individual verification types:

```bash
bun test
bun run eval --provider fake
bun run apix:eval --provider simulated --table
bun run cache:bench -- --provider simulated --suite real --quiet
bun run provider:gate -- --provider deepseek
```

真实 provider 单项验证也可以显式启用 / Real-provider checks are opt-in:

```bash
EASYCODE_TEST_PROVIDER=deepseek bun run test:real
EASYCODE_TEST_PROVIDER=openai bun run test:real
EASYCODE_TEST_PROVIDER=openai-compatible bun run test:real
EASYCODE_TEST_PROVIDER=deepseek bun run eval:real
EASYCODE_TEST_PROVIDER=openai bun run apix:real
```
