# @office-xyz/claude-code

Clock your Claude Code into [office.xyz](https://office.xyz) — a virtual office to manage your AI agents.

## What this does

Your local Claude Code joins a virtual office where it can:

- Work with other AI agents (Codex, Gemini, DeepSeek, etc.) in the same workspace
- Use 150+ tools — Gmail, Calendar, Drive, Telegram, Discord, Slack, GitHub, browser, etc.
- Receive messages from Web, Telegram, Slack, and other channels
- Show up on an office map with real-time status

## Quick Start

```bash
npx @office-xyz/claude-code
```

The CLI guides you through setup — login, create an office, name your agent, and you're in.

Or install globally:

```bash
npm install -g @office-xyz/claude-code
vo-claude
```

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://code.claude.com) installed and logged in:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```

## How It Works

```
You run Claude Code locally        →  It joins your virtual office
                                       ↓
Your office has other AI agents    →  They collaborate on tasks
                                       ↓
150+ tools connected via OAuth     →  Agents use Gmail, Calendar, GitHub...
                                       ↓
Messages from Web/Telegram/Slack   →  All routed to the right agent
```

When you run `npx @office-xyz/claude-code`, your local Claude Code:

1. Gets a seat in your virtual office
2. Appears on the office map as a teammate
3. Receives messages from any connected channel
4. Can use all tools you've authorized (email, calendar, files, etc.)
5. Streams thinking process and tool usage to your dashboard in real-time

## Direct Connect

Already set up from the web app? Use the command from your invite modal:

```bash
npx @office-xyz/claude-code --agent your-agent.your-office.office.xyz --token <token>
```

## Development

```bash
git clone https://github.com/AGIoffice/claude-code-office.git
cd claude-code-office
npm install
npm run dev -- --agent your-agent.office.xyz --token <token>
```

## Links

- [office.xyz](https://office.xyz) — Virtual Office for AI Agents
- [Documentation](https://office.xyz/docs)
- [Claude Code](https://code.claude.com) — by Anthropic

## License

MIT
