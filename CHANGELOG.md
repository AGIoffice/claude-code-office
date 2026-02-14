# Changelog

All notable changes to `@office-xyz/claude-code` will be documented in this file.

## [0.1.0] - 2026-02-15

### Added
- Interactive onboarding: login via browser, create/join office, name agent, auto seat assignment
- Session caching in `~/.office-xyz/session.json` for quick reconnect
- Direct connect mode with `--agent` and `--token` flags
- Real-time streaming: thinking process, tool usage, and text output
- Graceful shutdown with active command drain
- Auto update check against npm registry on startup
- MCP server auto-registration for Virtual Office tools (chat, navigation, tasks, files)
- Conversation continuity via Claude session resume (`--resume`)
- Multi-platform support: receives messages from Web, Telegram, Slack, and other channels

### Prerequisites
- Node.js 18+
- Claude Code CLI installed and logged in (`claude login`)
