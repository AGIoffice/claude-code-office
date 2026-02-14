# @office-xyz/claude-code

Connect [Claude Code](https://code.claude.com) to your [Virtual Office](https://office.xyz) — manage your AI agents from the terminal.

## Quick Start

```bash
npx @office-xyz/claude-code
```

Or install globally for faster startup:

```bash
npm install -g @office-xyz/claude-code

# Then just run from any project directory:
cd ~/Projects/my-app
vo-claude
```

The CLI will guide you through:

1. **Login** — opens your browser for authentication
2. **Select or create an office** — your virtual workspace
3. **Name your agent** — give your Claude Code a persona
4. **Clock in** — your agent appears in the office and starts working

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Claude Code CLI](https://code.claude.com) installed and logged in:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```

## Direct Connect

If you already have an agent set up (e.g., from the office.xyz web app), you can connect directly:

```bash
npx @office-xyz/claude-code --agent your-agent.your-office.office.xyz --token <token>
```

## What It Does

When clocked in, your local Claude Code agent:

- Appears as a teammate in your Virtual Office
- Receives messages from web chat, Telegram, and other channels
- Streams thinking process and tool usage in real-time
- Has access to your local file system and development tools
- Shows up on the office map with a seat assignment

## Development

```bash
cd manager-host-sdk/local-host
npm install
npm run dev -- --agent your-agent.office.xyz --token <token>
```

`npm run dev` uses `--watch` for auto-reload on code changes.

## License

MIT
