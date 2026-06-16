# EasyCode 🚀

EasyCode 是一个面向真实代码仓库的命令行 Coding Agent。它专注于“读代码、做计划、改代码、跑验证、长上下文记忆”的完整开发闭环，适合在本地仓库里安全、高效地完成日常修 Bug、重构、测试修复和代码探索。

*EasyCode is a command-line coding agent for real repositories. It focuses on the complete development loop of "reading code, planning changes, editing safely, running verification, and preserving context," making it ideal for resolving bugs, refactoring, fixing tests, and exploring architectures locally.*

---

## 🌟 核心优势 / Key Highlights

### 🚦 统一运行与按需规划 / Unified Run With Approval Gates
*   **单一运行入口**：直接运行 `easycode` 进入交互式开发会话；直接传入 prompt 则执行一次性任务并退出。
    *Single run entrypoint: `easycode` starts an interactive development session; passing a prompt runs one task and exits.*
*   **按需产出 Plan**：简单任务直接执行；多步骤、高风险、符号级修改任务会先返回 `<proposed_plan>`，等你批准后再继续落地。
    *Plan only when needed: simple work executes directly; multi-step, risky, or symbol-affecting work returns a `<proposed_plan>` first and waits for approval before implementation continues.*
*   **结构化计划驱动执行**：批准后的计划会保存为结构化 step 状态，支持 step 完成、验证失败后的局部重规划，以及跨 session 恢复。
    *Structured plans drive execution after approval, supporting step-level progress, bounded replanning, and session recovery.*

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
# 单次任务：直接传 prompt，必要时 EasyCode 会先给出 plan
# Single task: pass the prompt directly; EasyCode will plan first when needed
easycode "分析本项目如何处理大文件截断"

# 交互式开发：启动 TUI，会在同一会话里处理计划审批与执行
# Interactive development: start the TUI; planning approval and execution happen in the same session
easycode
```

---

## 🛠️ CLI 命令与配置 / CLI Commands & Configuration

### 主命令 / Main Commands

| 命令 / Command | 简体中文描述 | English Description |
| :--- | :--- | :--- |
| `easycode` | 启动统一运行模式的交互式会话；首次运行引导配置语言和 API Key。 | Starts the interactive unified run session and triggers first-run setup. |
| `easycode "<prompt>"` | 执行一次性任务并退出；必要时会先返回 `<proposed_plan>` 等待批准。 | Runs a one-off task and exits; may return a `<proposed_plan>` first when needed. |
| `easycode --session <id>` | 进入指定 session 继续开发。 | Continue work in a named session. |

### 命令行选项 / CLI Options

| 选项 / Option | 简体中文描述 | English Description |
| :--- | :--- | :--- |
| `--provider <name>` | 指定 AI provider（如 `deepseek`, `openai`, `openai-compatible`, `fake`）。 | Specify AI provider (e.g. `deepseek`, `openai`, `openai-compatible`, `fake`). |
| `--model <id>` | 指定模型 ID（覆盖 provider 的内置默认模型）。 | Specify model ID (overrides provider default). |
| `--max-tokens <n>` | 每次 API 调用的最大 token 数（默认 32000）。 | Max tokens per API call (default 32000). |
| `--max-steps <n>` | 最大执行步数（默认 66）。 | Max execution steps (default 66). |
| `--session <id>` | 加载指定的 session 进行继续开发。 | Load a specific session. |
| `--logger` | 启用详细调试日志。 | Enable detailed debug logs. |
| `--no-tui` | 禁用交互式终端 UI（TUI），退回到普通 CLI 命令行输出。 | Disable the interactive Terminal UI (TUI) and fallback to plain CLI output. |

> 兼容性说明 / Compatibility note
>
> 旧语法 `easycode build ...`、`easycode plan ...` 和 `--once` 仍可解析为兼容别名，但文档不再把它们视为主入口。

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
支持在 `.easycode/skills/`（项目级）或 `~/.easycode/skills/`（全局级）放置 markdown 编写的开发规范。
*Markdown files in `.easycode/skills/` (project-scoped) or `~/.easycode/skills/` (globally).*
*   **命令启用**：在 TUI 中使用 `/skill use <name>` 即可快速将特定开发领域规则融入会话。
    *Via slash command: Use `/skill use <name>` in the TUI to quickly load the skill.*
*   **自然语言启用**：也可以直接在对话中通过自然语言要求 AI 启用（例如：“使用代码审查规范”）。AI 会自动通过内置的 `skill` 工具完成按需渐进式加载。
    *Via natural language: Simply ask the AI to load a skill in the conversation (e.g. "use the code-review skill"). The AI will automatically call the built-in `skill` tool for progressive loading.*

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

## 🧭 普通模式 / Plan 模式 / Goal 模式的适用场景

EasyCode 支持三种执行策略：普通模式、Plan 模式、Goal 模式。  
它们的选择逻辑是：**按任务边界、风险、以及你是否愿意参与中间决策**。

### 普通模式（默认）
- **适合场景：** 单点修改、快速修复、局部排障、目标明确且改动范围可控的任务。
- **特点：** 直接执行，默认减少中间提问，适合日常开发节奏。
- **风险控制：** 复杂改动前可先切到 Plan 模式审批。

### Plan 模式
- **适合场景：** 多步骤任务、跨文件改动、重构、接口兼容性敏感改造。
- **特点：** 先给出 `<proposed_plan>`（分步骤、顺序、预期结果），等待用户批准再落地。
- **风险控制：** 更适合需要透明决策链和高可追溯性、生产环境改动。

### Goal 模式
- **适合场景：** 目标导向任务（如“完成某个重构收敛”）、需要持续迭代和复盘的复杂问题。
- **特点：** 以最终目标为主线持续推进，自动做阶段化分解与复检。
- **风险控制：** 在长期任务中更容易沉淀上下文、保持方向一致。

### 你可以如何选
- 选**普通模式**：一次性、低风险、可立即执行的任务。
- 选**Plan 模式**：改动范围较大、可能触及关键路径、你希望先看见计划。
- 选**Goal 模式**：边界较宽、存在探索性决策、需要持续对齐目标进度。

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

## 🏁 SWE-bench 适配 / SWE-bench Adapter

仓库内置了一个最小 SWE-bench 预测脚本，用来把 EasyCode 接到官方 harness 的 `predictions.jsonl` 格式上：
*The repo includes a minimal SWE-bench prediction adapter that lets EasyCode emit the `predictions.jsonl` format expected by the official harness.*

先拿本地 smoke 测试集最省事：
*The fastest path is to start from the bundled local smoke datasets:*

```bash
bun run swebench:dataset --preset lite
bun run swebench:dataset --preset verified
```

默认会生成：
*By default this writes:*

- `evals/swebench/lite-smoke.jsonl`
- `evals/swebench/verified-smoke.jsonl`

也可以按实例 id 自己导出：
*You can also export a custom subset by instance id:*

```bash
bun run swebench:dataset \
  --preset lite \
  --instance-ids sympy__sympy-20590 \
  --output /absolute/path/to/swebench-one.jsonl
```

```bash
bun run swebench:predictions --provider deepseek
```

默认行为：
*Default behavior:*

- 如果不传 `--dataset`，会从 Hugging Face 临时拉取 `Lite` smoke 子集到系统临时目录，跑完后删除。
- 如果不传 `--output`，会把预测结果写到当前执行目录，例如 `./swebench-lite-smoke-deepseek-predictions.jsonl`。
- 跑完后终端会打印一个结果表格，按实例展示 `status / patch / plan rounds / reason`。

如果你想指定本地数据集或换成 Verified：
*If you want a local dataset or the Verified preset instead:*

```bash
bun run swebench:predictions \
  --provider deepseek \
  --preset verified
```

```bash
bun run swebench:predictions \
  --provider deepseek \
  --dataset /absolute/path/to/swebench-instances.jsonl \
  --output ./predictions.jsonl \
  --instance-ids sympy__sympy-20590
```

输入数据文件需要包含这些字段：
*The local dataset file should contain these fields:*

- `instance_id`
- `repo`
- `base_commit`
- `problem_statement`
- `hints_text`（可选 / optional）

脚本会：
*The adapter will:*

1. 为每个实例镜像目标 GitHub 仓库并检出 `base_commit`。
2. 在实例 worktree 内直接驱动 EasyCode runner。
3. 如果 EasyCode 先返回 `<proposed_plan>`，自动继续一轮或多轮审批后的执行。
4. 抽取 `git diff --binary` 作为 `model_patch`，逐行写入 `predictions.jsonl`。

注意：
*Notes:*

- 这是无人值守 benchmark 模式，脚本会使用 `autoApprove(build rules)` 自动放行构建模式的权限请求，并自动批准 proposal plan。不要把它和有人手工审批的交互式结果混为一谈。
- 官方评测仍建议用 SWE-bench 自己的 Docker harness 跑；这个脚本只负责生成预测文件，不替代官方验收测试。
- 在 ARM Mac 上，本地评测通常需要在官方 harness 里额外加 `--namespace ''` 让镜像本地构建。

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
