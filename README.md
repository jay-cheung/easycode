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
/thinking on|off        开启或关闭模型 thinking
/effort <level>         设置思考强度：low、medium、high、max
/settings               查看当前会话设置
/sessions               查看已保存会话
/cancel                 取消正在运行的任务
```

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
