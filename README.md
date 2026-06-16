# EasyCode

EasyCode 是一个运行在本地代码仓库里的命令行 Coding Agent。它帮助你读代码、制定计划、修改文件、运行验证，并在多轮开发中保留上下文，适合日常修 Bug、理解项目、重构、补测试和推进较长的工程任务。

*EasyCode is a command-line coding agent for local repositories. It helps you understand code, plan changes, edit files, run checks, and keep context across longer development sessions.*

---

## 为什么使用 EasyCode / Why EasyCode

- **像结对开发一样工作**：你可以直接描述目标，EasyCode 会在仓库里读代码、解释判断、执行改动。  
  *Work like pair programming: describe the goal, and EasyCode reads the repo, explains decisions, and applies changes.*
- **简单任务直接做，复杂任务先计划**：小修复可以直接完成，高风险或跨文件任务可以先进入 Plan 模式审批。  
  *Small tasks can run directly; risky or multi-file tasks can go through Plan mode first.*
- **长任务不会轻易丢上下文**：Goal 模式适合持续推进迁移、重构、测试修复等目标型任务。  
  *Goal mode keeps longer migrations, refactors, and test-fix efforts moving with persistent context.*
- **默认围绕真实仓库工作**：它优先基于当前代码、项目规则、会话历史和验证结果做决策。  
  *It works from the real repository, project rules, session history, and verification results.*
- **可按团队习惯扩展**：你可以加入 Skills、项目资料、常用命令和联网搜索配置，让 Agent 更贴合你的项目。  
  *You can add skills, project knowledge, common commands, and web search configuration to match your team workflow.*

---

## 五分钟上手 / Quick Start

### 1. 安装 / Install

从 [Releases](https://github.com/FanFan-web-developer/easycode/releases) 下载对应平台二进制，并放入 `PATH`。

*Download the binary for your platform from [Releases](https://github.com/FanFan-web-developer/easycode/releases) and add it to `PATH`.*

**macOS Apple Silicon / arm64**

```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-darwin-arm64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**macOS Intel / x64**

```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-darwin-x64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**Linux x64**

```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-linux-x64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**Linux arm64**

```bash
curl -L https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-linux-arm64 -o /tmp/easycode && chmod +x /tmp/easycode && sudo mv /tmp/easycode /usr/local/bin/easycode
```

**Windows PowerShell / x64**

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\easycode"
Invoke-WebRequest -Uri "https://github.com/FanFan-web-developer/easycode/releases/latest/download/easycode-win-x64.exe" -OutFile "$env:USERPROFILE\easycode\easycode.exe"
# Add $env:USERPROFILE\easycode to your system PATH.
```

### 2. 配置模型 / Configure Provider

第一次运行 `easycode` 会引导你选择语言、Provider 和 API Key。推荐直接从交互式引导开始：

*The first `easycode` run guides you through language, provider, and API key setup. The easiest path is to start interactively:*

```bash
easycode
```

你也可以提前设置环境变量：

*You can also configure environment variables upfront:*

```bash
export EASYCODE_PROVIDER="deepseek"
export DEEPSEEK_API_KEY="sk-your-deepseek-key-here"
```

| Provider | 必需配置 / Required |
| :--- | :--- |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `openai-compatible` | `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_API_URL` |

### 3. 在仓库里开始工作 / Start In A Repository

进入你的项目根目录，然后启动 EasyCode：

*Open your repository root and start EasyCode:*

```bash
cd /path/to/your/repo
easycode
```

在交互式会话里，你可以直接输入：

*Inside the interactive session, try prompts like:*

```text
帮我解释这个项目的启动流程
定位为什么用户登录测试失败
把这个模块迁移到新的配置读取方式，先给我计划
```

如果只是一次性任务，也可以直接传 prompt：

*For one-off tasks, pass the prompt directly:*

```bash
easycode "分析这个仓库如何处理错误重试"
```

---

## 三种工作模式 / Working Modes

| 模式 / Mode | 适合场景 / Best for | 怎么使用 / How to use |
| :--- | :--- | :--- |
| 普通模式 / Normal | 小范围修复、代码解释、简单排障。<br>*Small fixes, code explanation, and simple debugging.* | 直接输入需求。<br>*Type your request directly.* |
| Plan 模式 / Plan | 跨文件改动、重构、关键路径修改，需要先确认方案。<br>*Multi-file changes, refactors, and critical-path edits that need plan review first.* | 使用 `/plan <request>`，批准后再执行。<br>*Use `/plan <request>`, then approve before execution.* |
| Goal 模式 / Goal | 较长目标，例如迁移模块、持续修复测试、分阶段重构。<br>*Longer goals such as module migration, ongoing test stabilization, or phased refactors.* | 使用 `/goal <objective>`，让 EasyCode 分阶段推进。<br>*Use `/goal <objective>` and let EasyCode work in phases.* |

选择时可以按风险判断：

*Choose by risk and scope:*

- **低风险、目标明确**：用普通模式。  
  *Low-risk and clear: use Normal mode.*
- **改动较大、想先看方案**：用 Plan 模式。  
  *Larger change or review needed: use Plan mode.*
- **任务较长、需要持续推进**：用 Goal 模式。  
  *Long-running objective: use Goal mode.*

---

## 常见任务示例 / Common Workflows

### 理解代码 / Understand Code

```text
这个仓库的请求入口在哪里？
解释用户注册流程，重点说明数据校验和错误处理。
这个函数被哪些地方调用？调用链是什么？
```

### 修 Bug / Fix Bugs

```text
定位这个测试失败的原因，并给出最小修复。
用户保存设置后刷新丢失，帮我排查并修复。
```

### 重构 / Refactor

```text
/plan 把这个模块里的重复校验逻辑抽成一个公共函数
/plan 将旧的配置读取方式迁移到新的 settings API
```

### 长目标 / Long-Running Goals

```text
/goal 完成登录模块的测试稳定性修复，直到本地验证通过
/goal 将支付模块迁移到新的 SDK，并保持现有行为兼容
```

---

## 交互式命令速查 / Interactive Commands

| 命令 / Command | 用途 / Purpose |
| :--- | :--- |
| `/help` | 查看帮助。 / Show help. |
| `/settings` | 查看当前模型、语言、技能和会话设置。 / Show active settings. |
| `/provider <name>` | 切换 Provider。 / Switch provider. |
| `/model <name>` | 切换模型。 / Switch model. |
| `/thinking on\|off` | 开启或关闭思考展示。 / Toggle thinking display. |
| `/effort <low\|medium\|high\|max>` | 设置思考强度。 / Set reasoning effort. |
| `/lang <code>` | 切换界面语言。 / Change UI language. |
| `/plan <request>` | 先生成计划，等待审批。 / Draft a plan before execution. |
| `/goal <objective>` | 启动长期目标。 / Start a long-running goal. |
| `/goal status` | 查看目标进度。 / Show goal progress. |
| `/goal pause\|resume` | 暂停或恢复目标。 / Pause or resume a goal. |
| `/sessions` | 查看历史会话。 / List saved sessions. |
| `/session switch <id>` | 切换会话。 / Switch session. |
| `/image <path-or-url>` | 给下一条消息附加图片。 / Attach an image. |
| `/skill list` | 查看可用 Skills。 / List skills. |
| `/skill use <name>` | 启用一个 Skill。 / Activate a skill. |
| `//text` | 发送以 `/` 开头的普通文本。 / Send `/text` as a prompt. |

---

## 让 EasyCode 更懂你的项目 / Project Customization

这些配置都是可选的。新用户可以先跳过，等日常使用稳定后再逐步加入。

*These are optional. New users can skip them and add customization later.*

| 能力 / Capability | 放在哪里 / Where | 什么时候用 / When to use |
| :--- | :--- | :--- |
| Skills | `.easycode/skills/` 或 `~/.easycode/skills/` | 固化团队开发规范、代码审查标准、测试要求。<br>*Capture team coding rules, review standards, and testing requirements.* |
| MCP 上下文服务 / MCP context servers | `.easycode/mcp.json` | 接入符合 MCP 的资源或上下文服务，供 Agent 按需读取。<br>*Connect MCP-compatible resources or context services for the agent to read when needed.* |
| 常用命令 / Commands | `.easycode/connectors.json` | 封装 lint、测试、构建等团队常用命令。<br>*Wrap common team commands such as lint, test, and build.* |
| 联网搜索 / Web search | `TAVILY_API_KEY` 或 `.easycode/websearch.json` | 需要查公开文档、版本信息或外部资料时使用。<br>*Use when public docs, version details, or external references are needed.* |

---

## 验证改动 / Verify Changes

如果你在开发 EasyCode 本身，推荐使用统一质量门：

*If you are developing EasyCode itself, use the unified quality gate:*

```bash
bun run gate
```

只想跑单元测试时：

*For unit tests only:*

```bash
bun test
```

在普通项目中，你也可以直接让 EasyCode 运行项目自己的验证命令，例如：

*In your own repository, ask EasyCode to run your project checks, for example:*

```text
运行本项目的测试并修复失败项
```

---

## 常用 CLI 选项 / CLI Options

| 选项 / Option | 说明 / Description |
| :--- | :--- |
| `--provider <name>` | 指定 Provider，例如 `deepseek`、`openai`、`openai-compatible`。<br>*Choose the provider, such as `deepseek`, `openai`, or `openai-compatible`.* |
| `--model <id>` | 指定模型。<br>*Choose the model.* |
| `--session <id>` | 继续指定会话。<br>*Resume a specific session.* |
| `--root <path>` | 指定项目根目录。<br>*Set the project root directory.* |
| `--no-tui` | 使用普通命令行输出。<br>*Use plain command-line output instead of the TUI.* |
| `--logger` | 打开调试日志。<br>*Enable debug logs.* |

---

## 从源码开发 / Develop From Source

```bash
git clone https://github.com/FanFan-web-developer/easycode.git
cd easycode
bun install
bun run gate
bun run build
```

---

## 开源协议 / License

本项目采用 [MIT License](./LICENSE) 开源协议。

*Licensed under the [MIT License](./LICENSE).*
