# EasyCode

中文 | [English](README.en.md)

EasyCode 是一个面向真实代码仓库的命令行 Coding Agent。它专注于“读代码、做计划、改代码、跑验证、保留上下文”，适合在本地仓库里完成日常修 bug、重构、测试修复和代码探索。

## 项目亮点

- **计划 / 执行分离**：`plan` 模式只读分析并输出方案，`build` 模式才允许修改文件。
- **真实仓库工作流**：内置文件读取、精确编辑、patch、bash、Git diff/status/stage/commit、代码导航等工具。
- **安全边界明确**：默认限制写入项目外路径，危险命令会被拒绝，敏感输出会做基础脱敏。
- **长上下文可持续**：支持会话保存、上下文压缩、项目记忆和技能按需加载。
- **多 Provider 支持**：内置 `openai`、`deepseek`、`openai-compatible` 和离线测试用 `fake`。
- **可验证质量**：提供离线测试、fake eval、APIx eval、cache benchmark 和真实 provider smoke test。

## 安装

从 [GitHub Releases](https://github.com/FanFan-web-developer/easycode/releases) 下载对应平台二进制并放入 `PATH`。

macOS arm64 示例：

```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-darwin-arm64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

验证安装：

```bash
easycode build --provider fake
```

从源码构建：

```bash
git clone https://github.com/FanFan-web-developer/easycode.git
cd easycode
bun install
bun run build
```

## 配置

在项目根目录创建 `.env`，或直接通过 shell 环境变量提供凭据。shell 环境变量优先级更高。

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro

OPENAI_COMPAT_API_KEY=...
OPENAI_COMPAT_API_URL=https://provider.example/v1/chat/completions
OPENAI_COMPAT_MODEL=provider-model
```

## 使用

交互式执行：

```bash
easycode build --provider deepseek
easycode plan --provider deepseek
easycode build --provider deepseek --tui
```

单次任务：

```bash
easycode build --once "修复失败的测试" --provider deepseek
easycode plan --once "给出最小安全改动方案" --provider deepseek
```

本地开发时也可以直接用 Bun 运行源码：

```bash
bun run src/cli.ts build --provider fake
bun run src/cli.ts plan --provider fake
bun run src/cli.ts build --provider fake --tui
```

## 常用命令

```text
/model <provider> [id]  切换 provider 或模型
/image <path-or-url>    给下一轮 prompt 附加图片
/skill list             查看可用技能
/skill use <name>       启用技能
/skill remove <name>    移除已启用的技能
/thinking on|off        开启或关闭模型 thinking
/effort <level>         设置思考强度：low、medium、high、max
/settings               查看当前会话设置
/sessions               查看已保存会话
/cancel                 取消正在运行的任务
```

## 数据源配置

数据源为 AI 提供额外的上下文（文档、代码规范、搜索结果、常用命令），以只读 JSON 文件配置在项目 `.easycode/` 目录下，**无需重启进程**即可生效。

---

### MCP（结构化知识源）

`.easycode/mcp.json` —— 将常用文档、架构说明等预配为结构化条目，供对话中引用。

```json
{
  "servers": [
    {
      "name": "docs",
      "resources": [
        { "uri": "doc://api-guide", "title": "API 指南", "description": "项目 API 使用说明", "text": "详细的文档正文内容..." }
      ]
    }
  ]
}
```

保存后可用以下工具：
- **mcp_list_resources** — 列出所有配置的 MCP 资源
- **mcp_read_resource** — 按 uri 和 server 读取某条资源正文

---

### Web Search（真实搜索 + 本地 fixture）

`.easycode/websearch.json` 支持两种模式：

- 配置 `defaultEngine` 或调用工具时传 `engine`：发起真实搜索。
- 不配置搜索引擎或显式 `live: false`：读取本地 `results` fixture，便于离线测试。

Google Programmable Search 示例：

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
        "hl": "zh-CN"
      }
    }
  ],
  "results": [
    { "url": "https://example.com", "title": "Example", "snippet": "引用摘要", "retrievedAt": "2026-05-28T00:00:00.000Z" }
  ]
}
```

`google` 内建引擎使用 Google Programmable Search JSON API，请配置 `extraParams.cx`。

Brave Search 示例：

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

Tavily 示例：

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

自定义 JSON 搜索引擎示例：

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

`web_search` 参数：`query`、`limit`、`engine`、`live`。API key 建议只通过环境变量提供，不要写入仓库。

---

### Connector（本地命令封装）

`.easycode/connectors.json` —— 把常用 shell 命令封装为工具，在对话中按需调用，每次执行需授权。

```json
{
  "tools": [
    {
      "name": "lint",
      "description": "运行 linter 检查代码",
      "command": "bun run lint"
    },
    {
      "name": "test",
      "description": "运行测试",
      "command": "bun test"
    }
  ]
}
```

保存后可用以下工具：
- **connector_list** — 列出所有可用的 connector
- **connector_call <name>** — 执行指定的 shell 命令

---

### Skill（行为指令注入）

Skill 是 markdown 文件，按以下优先级搜索（同名后面的覆盖前面的）：

| 搜索目录 | 范围 |
|---|---|
| `.agent/skills/` | 项目级 |
| `.easycode/skills/` | 项目级 |
| `~/.agent/skills/` | 用户全局 |
| `~/.easycode/skills/` | 用户全局 |

每个 skill 文件格式如下（文件名为任意名称，支持子目录）：

```markdown
---
name: code-review
description: 代码审查规则和最佳实践
---

## 审查原则

- 关注可维护性 > 性能优化
- ...
```

保存后在交互模式下通过 slash 命令管理：
- `/skill list` — 列出所有可用 skill
- `/skill use code-review` — 在当前会话启用 skill
- `/skill remove code-review` — 移除已启用的 skill
- `/skill clear` — 清空所有已启用 skill

启用后，skill 完整内容注入到对话上下文中，影响模型的回复风格和规则遵循。

## CLI 命令与配置

### 主命令

| 命令 | 用途 |
|---|---|
| `easycode build [options]` | 执行模式：分析 → 改代码 → 验证 |
| `easycode plan [options]` | 计划模式：只读分析，输出方案，不修改文件 |

### 命令行选项

| 选项 | 说明 |
|---|---|
| `--once <prompt>` | 单次任务模式，执行完成后退出 |
| `--provider <name>` | 指定 AI provider（见下方列表） |
| `--model <id>` | 指定模型 ID（覆盖 provider 默认模型） |
| `--max-tokens <n>` | 每次 API 调用的最大 token 数（默认 32000） |
| `--max-steps <n>` | 最大执行步数（默认 66） |
| `--root <path>` | 项目根目录（默认当前目录） |
| `--session <id>` | 加载指定 session |
| `--logger` | 输出详细日志 |
| `--tui` | 启动 TUI 交互界面 |

**示例：**
```bash
easycode build --provider deepseek
easycode plan --once "分析项目结构" --provider openai
easycode build --provider deepseek --tui
easycode build --once "修复失败的测试" --provider openai --max-steps 20
```

### 交互式 Slash 命令

在交互模式下通过 `/` 前缀调用：

| 命令 | 功能 |
|---|---|
| `/model <provider> [id]` | 切换 provider 或模型 |
| `/image <path-or-url>` | 给下一轮 prompt 附加图片 |
| `/image clear` | 清除待发送图片 |
| `/skill list` | 列出可用技能 |
| `/skill use <name>` | 启用指定技能 |
| `/skill remove <name>` | 移除已启用的技能 |
| `/skill clear` | 清空所有已启用技能 |
| `/thinking on\|off` | 开启或关闭模型 thinking |
| `/effort <level>` | 设置思考强度：`low`、`medium`、`high`、`max` |
| `/settings` | 查看当前会话设置 |
| `/sessions` | 查看已保存会话 |
| `//text` | 将 `/text` 作为普通 prompt 发送 |

### 环境变量 / `.env` 配置

在项目根目录的 `.env` 文件中配置凭据，或通过 shell 环境变量提供（shell 变量优先级更高）。

```env
# Provider 选择（若不传 --provider 则读取此项）
EASYCODE_PROVIDER=deepseek

# OpenAI
OPENAI_API_KEY=sk-...
# 默认模型：gpt-4o

# DeepSeek
DEEPSEEK_API_KEY=sk-...
# 默认模型：deepseek-chat

# OpenAI 兼容接口
OPENAI_COMPAT_API_KEY=sk-...
OPENAI_COMPAT_API_URL=https://your-provider.example/v1/chat/completions
OPENAI_COMPAT_MODEL=your-model
```

### 可用 Provider

| Provider 名称 | 说明 |
|---|---|
| `openai` | OpenAI API（默认模型 gpt-4o） |
| `deepseek` | DeepSeek API（默认模型 deepseek-chat） |
| `openai-compatible` | 任何 OpenAI 兼容接口 |
| `fake` | 离线模拟（测试/开发用） |
| `simulated` | 同 fake，模拟模式 |

## 验证

```bash
bun run verify:v1
bun test
bun run eval --provider fake
bun run apix:eval --provider simulated --table
bun run cache:bench -- --provider simulated --suite real --quiet
```

真实 provider 验证需要显式启用：

```bash
EASYCODE_TEST_PROVIDER=deepseek bun run test:real
EASYCODE_TEST_PROVIDER=openai bun run test:real
EASYCODE_TEST_PROVIDER=deepseek bun run eval:real
EASYCODE_TEST_PROVIDER=openai bun run apix:real
```
