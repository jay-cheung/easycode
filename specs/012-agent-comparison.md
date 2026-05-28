# Agent Comparison Notes

Research timestamp: 2026-05-28 Asia/Singapore.

## Source Snapshot

- OpenCode: official docs describe it as an open source AI coding agent available as terminal interface, desktop app, or IDE extension. The docs include TUI/CLI/Web/IDE surfaces, tools, permissions, LSP servers, MCP servers, agent skills, custom tools, and Plan/Build workflow.
- Claude Code: official docs describe it as an agentic coding tool that reads codebases, edits files, runs commands, and integrates with terminal, IDE, desktop app, and browser surfaces. Its architecture page frames Claude Code as the agentic harness around Claude, providing tools, context management, and execution environment.
- Codex CLI: official OpenAI docs describe Codex CLI as a local terminal coding agent that can read, change, and run code in the selected directory. The current CLI docs list interactive TUI, model/reasoning controls, images, local review, subagents, web search, cloud tasks, scripting, MCP, and approval modes.

## Product Implications For EasyCode

- TUI is table stakes, not a nice-to-have: all three reference tools expose a terminal-first interactive surface.
- MCP and WebSearch should be first-class retrieval surfaces with citations, not ad hoc shell commands.
- Plan/Build separation is a competitive baseline because OpenCode and EasyCode both expose this workflow explicitly, and Claude/Codex both support planning/review flows.
- LSP/AST is justified as a differentiator for safer edits and better context selection because OpenCode documents LSP server configuration and Codex/Claude compete on richer codebase understanding.
- Permission prompts need to stay explicit because Codex documents approval modes and Claude/OpenCode both rely on tool execution boundaries.

## Sources

- https://opencode.ai/docs
- https://code.claude.com/docs
- https://code.claude.com/docs/en/how-claude-code-works
- https://developers.openai.com/codex/cli
