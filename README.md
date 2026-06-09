# EasyCode 🚀

EasyCode 是一个面向真实代码仓库的命令行 Coding Agent。它专注于“读代码、做计划、改代码、跑验证、长上下文记忆”的完整开发闭环，适合在本地仓库里安全、高效地完成日常修 Bug、重构、测试修复和代码探索。

*EasyCode is a command-line coding agent for real repositories. It focuses on the complete development loop of "reading code, planning changes, editing safely, running verification, and preserving context," making it ideal for resolving bugs, refactoring, fixing tests, and exploring architectures locally.*

---

## 🌟 核心优势 / Key Highlights

### 🚦 计划与执行分离 / Plan & Build Separation
*   **Plan 模式（只读）**：AI 仅执行探索与静态分析，输出 Markdown 格式的执行计划，绝不触碰文件。
    *Plan mode (read-only): AI performs exploration and static analysis, outputting a Markdown plan without editing any files.*
*   **Build 模式（读写）**：在用户确认 Plan 后，AI 会在授权下按步骤精准修改文件。
    *Build mode (read-write): After the user approves the plan, the AI proceeds to modify files step-by-step under authorization.*

### 🔍 增量 AST 代码索引 / AST-Grep Code Indexing
*   不仅是正则 `grep`。EasyCode 在本地基于 `ast-grep` 维护轻量级增量 AST 索引。
    *More than regex grep. EasyCode maintains a lightweight, incremental AST index locally powered by `ast-grep`.*
*   支持精确的 `findDefinition`、`findReferences`、`callGraph` 和 `repoMap` 骨架缓存，能够智能过滤局部变量命名碰撞，做出更安全的重构计划。
    *Supports precise definition, reference, call graph, and skeleton repoMap caches, filtering out local binding name collisions to plan safer edits.*

### 🛡️ 智能自动审查与沙箱安全 / Sandbox & Auto-Reviewer
*   **安全隔离**：内置项目根目录写限制，隔离的 Bash 执行环境，并自动对控制台输出中的 API Key/Secret 进行红线脱敏。
    *Sandbox isolation: Project-root write limits, isolated bash shell execution, and automatic secret redaction from stdout.*
*   **自动放行**：智能识别安全只读操作，免除频繁授权弹窗；仅在执行写指令或网络请求等危险动作时发起确认，降低确认疲劳。
    *Auto-reviewer: Approves safe read-only operations automatically to avoid prompt fatigue; user authorization is only requested for risky write or network actions.*

### 🧠 上下文账本与持久化项目记忆 / Ledger & Project Memory
*   **Context Ledger**：跟踪当前假设、约束和排查决策，在多轮对话中自动执行 Compaction 压缩以降低 Token 消耗。
    *Context ledger: Tracks current hypotheses, constraints, and decision logs, automatically compacting old history to optimize tokens.*
*   **Project Memory**：支持持久化存储项目特定偏好、常见错误模式和成功工作流，在检测到 `继续`、`上次` 等触发词时自动召回。
    *Project memory: Persists project-scoped preferences, failure patterns, and successful workflows, automatically recalling them on continuation keywords.*

---

## 🚀 快速上手 / Quick Start

### 1. 安装 / Install EasyCode
你可以直接从 [Releases](https://github.com/FanFan-web-developer/easycode/releases) 下载对应平台的二进制并加入 `PATH`：
*Download the binary for your platform from Releases and add it to your PATH:*

**macOS (Apple Silicon / arm64):**
```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-darwin-arm64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**macOS (Intel / x64):**
```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-darwin-x64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**Linux (x64):**
```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-linux-x64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**Linux (arm64):**
```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-linux-arm64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**Windows (PowerShell / x64):**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\easycode"
Invoke-WebRequest -Uri "https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-win-x64.exe" -OutFile "$env:USERPROFILE\easycode\easycode.exe"
# 将 $env:USERPROFILE\easycode 添加到系统 PATH 环境变量中
# Add $env:USERPROFILE\easycode to your system PATH environment variable
```

### 2. 配置 API Key / Setup API Key
EasyCode 默认使用 **DeepSeek**（支持 reasoning 思考逻辑，且无需 `--provider` 标记）：
*EasyCode defaults to DeepSeek (supporting reasoning effort, no `--provider` flag required):*

```bash
export DEEPSEEK_API_KEY="sk-your-deepseek-key-here"
```

### 3. 运行你的第一个任务 / Run Your First Task
在你的本地代码仓库根目录下运行以下命令：
*Run the command in your repository root directory:*

```bash
# 计划模式：分析任务并给出修改计划（安全无副作用）
# Plan mode: Analyze the task and propose changes (safe and read-only)
easycode plan --once "分析本项目如何处理大文件截断"

# 执行模式：启动炫酷的交互式终端 UI（TUI）
# Build mode: Start the interactive Terminal UI (TUI)
easycode build --tui
```

---

## 🛠️ CLI 命令与配置 / CLI Commands & Configuration

### 主命令 / Main Commands

| 命令 / Command | 简体中文描述 | English Description |
| :--- | :--- | :--- |
| `easycode plan` | **计划模式**：只读分析，输出修改方案，不修改任何文件。 | **Plan mode**: Read-only analysis, outputs plan, no file changes. |
| `easycode build` | **执行模式**：允许 AI 在获得授权后读取、编辑文件并执行测试。 | **Build mode**: Allows AI to read, edit files, and run commands upon approval. |

### 命令行选项 / CLI Options

| 选项 / Option | 简体中文描述 | English Description |
| :--- | :--- | :--- |
| `--once <prompt>` | 单次任务模式，执行完成后退出。 | Single task mode, exits after completion. |
| `--provider <name>` | 指定 AI provider（如 `deepseek`, `openai`, `openai-compatible`, `fake`）。 | Specify AI provider (e.g. `deepseek`, `openai`, `openai-compatible`, `fake`). |
| `--model <id>` | 指定模型 ID（覆盖 provider 的内置默认模型）。 | Specify model ID (overrides provider default). |
| `--max-tokens <n>` | 每次 API 调用的最大 token 数（默认 32000）。 | Max tokens per API call (default 32000). |
| `--max-steps <n>` | 最大执行步数（默认 66）。 | Max execution steps (default 66). |
| `--session <id>` | 加载指定的 session 进行继续开发。 | Load a specific session. |
| `--logger` | 启用详细调试日志。 | Enable detailed debug logs. |
| `--tui` | 启动交互式终端 UI（TUI）。 | Start the TUI interactive interface. |

---

## 📂 扩展上下文数据源 / Data Sources

数据源以 JSON 文件形式配置在项目 `.easycode/` 目录下，**无需重启进程，即刻生效**：
*Data sources are configured under `.easycode/` in JSON format and take effect **without restarting the process**:*

### 1. MCP (模型上下文协议 / Model Context Protocol)
`.easycode/mcp.json` —— 预配项目文档或架构指南等结构化条目供 AI 对话中按需读取。
*`.easycode/mcp.json` — Preconfigures structured entries like docs and conventions for reference.*
```json
{
  "servers": [
    {
      "name": "docs",
      "resources": [
        { "uri": "doc://api-rules", "title": "API 开发规范", "description": "项目内部 API 规范", "text": "..." }
      ]
    }
  ]
}
```

### 2. Connectors (本地命令封装 / Command Connectors)
`.easycode/connectors.json` —— 将常用 shell 命令封装为工具动作，供 AI 调用（受同一安全审查策略保护）。
*`.easycode/connectors.json` — Wraps common shell commands as tools (guarded by the same security policies).*
```json
{
  "tools": [
    {
      "name": "lint",
      "description": "运行项目 Linter 校验代码",
      "command": "bun run lint"
    }
  ]
}
```

### 3. Skills (行为指令注入 / Skills)
支持在 `.easycode/skills/`（项目级）或 `~/.easycode/skills/`（全局级）放置 markdown 编写的开发规范。在 TUI 中使用 `/skill use <name>` 即可快速将特定开发领域规则融入会话。
*Markdown files in `.easycode/skills/` (project-scoped) or `~/.easycode/skills/` (globally). Manage rules at runtime via `/skill use <name>`.*

---

## ⌨️ 交互式 Slash 命令 / Interactive Slash Commands

在交互会话（CLI / TUI）中，通过 `/` 前缀控制 Agent 的行为：
*In interactive mode, use the `/` prefix to control session settings:*

| 斜杠命令 / Command | 简体中文描述 | English Description |
| :--- | :--- | :--- |
| `/model <provider> [id]` | 切换 AI 服务商或具体模型。 | Switch provider or model ID. |
| `/thinking on\|off` | 开启或关闭 reasoning 思考路径的展示。 | Enable or disable model thinking. |
| `/effort <level>` | 设置 DeepSeek 思考强度 (`low`, `medium`, `high`, `max`)。 | Set reasoning effort. |
| `/lang <code>` | 切换 UI 语言（支持 `zh`, `en`, `ja`, `fr`, `ko`, `de`）。 | Set UI language. |
| `/sessions` | 列出所有已保存的历史会话。 | List saved sessions. |
| `/session switch <id>` | 切换到指定开发会话。 | Switch to another session. |
| `/session delete <id>` | 删除指定会话（删除前将重要经验归档至长期项目记忆）。 | Archive summary to memory and delete session. |
| `/settings` | 查看当前会话的预算、模型设置与状态。 | Show current session settings. |

---

## 🧪 统一验证与质量控制 / Quality Gate

要执行统一的测试和网关检查以验证改动，只需在项目根目录运行：
*To run the unified testing and linting gateway to verify changes:*

```bash
bun run gate
```

**检查流水线依次包含 / The pipeline runs:**
1. `typecheck` 静态类型检查 / Static type check.
2. `bun test` 单元测试套件 / Unit tests.
3. `fake eval` 模拟评估 / Offline fake evaluations.
4. `APIx` 本地硬性测试指标（Hard-gate） / Local APIx hard-gate evaluation.
5. `cache benchmark` 缓存命中与成本评估 / Cache hit and cost benchmark.
6. `build` 生产打包验证 / Production bundle checks.
7. 多 Provider 联合冒烟测试 / Multi-provider smoke tests.

---

## 📝 源码构建与开发 / Source Code & Development

1.  **克隆项目 / Clone:**
    ```bash
    git clone https://github.com/FanFan-web-developer/easycode.git
    cd easycode
    ```
2.  **安装依赖 / Install dependencies:**
    ```bash
    bun install
    ```
3.  **运行测试 / Run tests:**
    ```bash
    bun test
    ```
4.  **编译构建 / Build:**
    ```bash
    bun run build
    ```

---

## 📄 开源协议 / License

本项目采用 [MIT License](./LICENSE) 开源协议。
*Licensed under the [MIT License](./LICENSE).*
