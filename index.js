#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// @virtual-office/local-host — Connect a local CLI agent to Virtual Office
//
// Usage:
//   npx @virtual-office/local-host \
//     --agent claude.aladdin.office.xyz \
//     --token eyJhbGci... \
//     --provider claude-code
//
// The adapter connects to the Manager WebSocket, runs Claude Code in
// headless mode (-p --output-format stream-json), and bridges streaming
// responses between the office and the local CLI process.
// ═══════════════════════════════════════════════════════════════════════════
import { WebSocket } from 'ws'
import chalk from 'chalk'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { spawn, execSync, exec as execCb } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(execCb)
import { createInterface } from 'readline'
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, unlinkSync } from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
// Inline tool name normalizer (can't import from parent CJS package — ESM/CJS conflict)
// Maps raw CLI tool names to standard frontend TOOL_CONFIG keys
const TOOL_NAME_MAP = {
  // Codex CLI
  command_execution: 'Bash', file_edit: 'FileEdit', file_read: 'FileRead',
  file_change: 'FileEdit', file_write: 'FileWrite', web_search: 'WebSearch',
  mcp_call: 'Mcp', mcp_tool_call: 'Mcp', unknown_tool: 'default',
  // Gemini CLI
  shell: 'Bash', edit: 'Edit', read: 'Read', write: 'Write',
  search_files: 'Grep', list_files: 'LS', web_fetch: 'WebFetch', google_search: 'WebSearch',
  // Kimi / DeepSeek / Qwen CLI
  execute_command: 'Bash', read_file: 'Read', write_file: 'Write', edit_file: 'Edit',
  search: 'Grep', run_command: 'Bash', code_edit: 'FileEdit', code_search: 'Grep',
  terminal: 'Bash', file_operation: 'FileEdit',
  // Claude server-side tools (content_block type → display name)
  server_tool_use: 'ServerTool', web_search_tool_result: 'WebSearch',
  web_fetch_tool_result: 'WebFetch', code_execution_tool_result: 'CodeExecution',
  mcp_tool_use: 'Mcp', mcp_tool_result: 'Mcp',
  bash_code_execution_tool_result: 'Bash',
  text_editor_code_execution_tool_result: 'Edit',
  tool_search_tool_result: 'ToolSearch', container_upload: 'Upload',
  // General aliases
  bash: 'Bash', grep: 'Grep', glob: 'Glob', ls: 'LS',
}
function normalizeToolName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'default'
  const lower = rawName.toLowerCase()
  return TOOL_NAME_MAP[lower] || TOOL_NAME_MAP[rawName] || rawName
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── CLI arguments ──────────────────────────────────────────────────────────

// In production, connect through Chat Bridge's /ws/host proxy.
// For local dev, override with --manager ws://localhost:4789
const DEFAULT_MANAGER_URL =
  process.env.MANAGER_HOST_URL ||
  process.env.MANAGER_URL ||
  process.env.CHAT_BRIDGE_WS_URL ||
  'wss://chatbridge.aladdinagi.xyz/ws/host'

const argv = yargs(hideBin(process.argv))
  .usage('$0 — Connect Claude Code to your Virtual Office')
  .option('agent', {
    alias: 'a',
    type: 'string',
    describe: 'Agent handle for direct connect (e.g. claude.aladdin.office.xyz)',
  })
  .option('token', {
    alias: 't',
    type: 'string',
    describe: 'Connection token for direct connect',
    default: process.env.VO_TOKEN || undefined,
  })
  .option('manager', {
    alias: 'M',
    type: 'string',
    describe: 'Manager WebSocket URL',
    default: DEFAULT_MANAGER_URL,
  })
  .option('provider', {
    type: 'string',
    describe: 'CLI provider: claude-code, codex, gemini',
    default: 'claude-code',
  })
  .option('model', {
    alias: 'm',
    type: 'string',
    describe: 'Model to pass to the CLI agent',
  })
  .option('workspace', {
    alias: 'w',
    type: 'string',
    describe: 'Working directory for the agent',
    default: process.cwd(),
  })
  .option('cli-command', {
    type: 'string',
    describe: 'Override the CLI binary (e.g. /usr/local/bin/claude)',
  })
  .option('channel', {
    type: 'string',
    describe: 'Only show messages from this channel (web, telegram, slack, discord, office, feishu, wechat)',
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    describe: 'Show debug logs with timestamps (use --no-verbose to hide)',
    default: true,
  })
  .example('$0', 'Interactive setup (login, create office, name agent)')
  .example('$0 --agent claude.my.office.xyz --token xxx', 'Direct connect (skip login)')
  .help()
  .parse()

// ── Provider configs ───────────────────────────────────────────────────────

const PROVIDERS = {
  'claude-code': {
    command: 'claude',
    // -p = headless print mode (non-interactive)
    // --output-format stream-json = NDJSON streaming for real-time token output
    // --verbose --include-partial-messages = emit text_delta events as they arrive
    // --dangerously-skip-permissions = no permission prompts in headless mode
    baseArgs: [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ],
    modelFlag: '--model',
    defaultModel: 'claude-opus-4-6',
    envCheck: null, // Claude Code uses local session (claude login), not API key
    installHint: 'npm install -g @anthropic-ai/claude-code',
    // --resume SESSION_ID to continue conversations
    resumeFlag: '--resume',
  },
  codex: {
    command: 'codex',
    baseArgs: [],
    modelFlag: '--model',
    defaultModel: 'o4-mini',
    envCheck: 'OPENAI_API_KEY',
    installHint: 'npm install -g @openai/codex',
    resumeFlag: null,
  },
  gemini: {
    command: 'gemini',
    baseArgs: [],
    modelFlag: '--model',
    defaultModel: 'gemini-2.5-pro',
    envCheck: 'GEMINI_API_KEY',
    installHint: 'npm install -g @google/gemini-cli',
    resumeFlag: null,
  },
}

const providerConfig = PROVIDERS[argv.provider]
if (!providerConfig) {
  console.error(chalk.red(`Unknown provider "${argv.provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}`))
  process.exit(1)
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Shell-escape a string using single quotes.
 * Single-quoting prevents ALL shell interpretation (no $, `, (, ), etc.).
 * The only char that can't appear inside single quotes is ' itself,
 * which is handled by: end quote, escaped quote, start quote → '\''
 */
function shellEscapeArg(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// ── Logging ────────────────────────────────────────────────────────────────

let label = argv.agent ? (argv.agent.split('.')[0] || argv.agent) : 'local-host'

// Debug log — only shown with --verbose flag (timestamped, dim)
function log(...args) {
  if (!argv.verbose) return
  console.log(chalk.dim(`[${new Date().toISOString()}][${label}]`), ...args)
}

// User-facing log — always shown (conversation activity, status updates)
function info(...args) {
  console.log(...args)
}

// ── MCP Server Pre-test ───────────────────────────────────────────────────
/**
 * Quick test: spawn the MCP server and check if it responds within 5s.
 * If it hangs or crashes, return false so we skip --mcp-config.
 */
async function testMcpServer(configPath) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const serverConfig = Object.values(config.mcpServers || {})[0]
    if (!serverConfig) return false

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try { child.kill() } catch {}
        log(chalk.yellow(`[mcp] Server timed out during pre-test (5s)`))
        resolve(false)
      }, 5000)

      const child = spawn(serverConfig.command, serverConfig.args, {
        env: { ...process.env, ...serverConfig.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        log(chalk.yellow(`[mcp] Server failed to start: ${err.message}`))
        resolve(false)
      })

      // MCP server should print to stderr on startup. If it writes anything, it's alive.
      let stderrOutput = ''
      child.stderr.on('data', (chunk) => {
        stderrOutput += chunk.toString()
      })

      // Give it 2s to start, then check if it's still alive
      setTimeout(() => {
        if (child.exitCode !== null) {
          // Already exited = crashed
          clearTimeout(timeout)
          log(chalk.yellow(`[mcp] Server exited with code ${child.exitCode}`))
          if (stderrOutput) log(chalk.dim(`[mcp] stderr: ${stderrOutput.trim().slice(0, 200)}`))
          resolve(false)
        } else {
          // Still running = good
          clearTimeout(timeout)
          try { child.kill() } catch {}
          log(chalk.green(`[mcp] Server pre-test passed`))
          resolve(true)
        }
      }, 2000)
    })
  } catch (err) {
    log(chalk.yellow(`[mcp] Pre-test error: ${err.message}`))
    return false
  }
}

// ── Manager WebSocket ──────────────────────────────────────────────────────

// hostId and managerUrl are set here for direct connect mode.
// In onboarding mode, they are overridden in startup() after login.
let hostId = argv.agent || 'pending' // Convention: local agent hostId = agentHandle
const managerUrl = new URL(argv.manager)
if (argv.agent) {
  managerUrl.searchParams.set('role', 'host')
  managerUrl.searchParams.set('hostId', hostId)
  if (argv.token) {
    managerUrl.searchParams.set('token', argv.token)
  }
}

let wsRef = null
let reconnectAttempts = 0
let tokenRetryAttempted = false  // Track whether we've already retried a 1008 rejection
let onboardingSeat = null        // Seat assigned during onboarding, passed to clock-in banner
let hasShownClockInBanner = false // Prevent duplicate banners
const MAX_RECONNECT_DELAY_MS = 30_000
let registryHeartbeatTimer = null
const REGISTRY_HEARTBEAT_INTERVAL_MS = 30_000  // Report liveness to Registry every 30s

// ── Graceful shutdown handling ────────────────────────────────────────────
// During ECS rolling deployments, Chat Bridge sends `server_shutdown` before
// closing the WS.  When we see that message, we keep active CLI processes
// alive and buffer outbound events, then flush the buffer after reconnect.
let gracefulDisconnect = false
let gracefulKillTimer = null
const pendingSendBuffer = []
const GRACEFUL_RECONNECT_TIMEOUT_MS = 60_000  // Kill children if reconnect takes >60s
const MAX_PENDING_BUFFER = 1000               // Safety cap on buffered events
const workspace = path.resolve(argv.workspace)
const model = argv.model || providerConfig.defaultModel

// ── Session tracking ───────────────────────────────────────────────────────
// Map VO sessionId → Claude session_id for conversation continuity.
// Persisted to ~/.claude/ (not tmpdir) so sessions survive reboots.
// macOS cleans up os.tmpdir() (/var/folders/.../T/) on reboot, which caused
// session bindings to disappear after restart. ~/.claude/ is where Claude
// itself stores session data, so it's stable across reboots and clock-ins.
// --resume and --append-system-prompt coexist fine, so resumed sessions
// still pick up fresh system prompts and MCP tools (registered globally).
const SESSION_MAP_DIR = path.join(os.homedir(), '.claude')
const SESSION_MAP_FILE = path.join(SESSION_MAP_DIR, `vo-sessions-${(argv.agent || 'pending').replace(/\./g, '-')}.json`)
const sessionMap = new Map()

// Load persisted sessions from previous clock-in (if any)
try {
  const raw = readFileSync(SESSION_MAP_FILE, 'utf-8')
  const parsed = JSON.parse(raw)
  // Support both formats: Array of entries [[k,v], ...] and Object {k: v}
  const entries = Array.isArray(parsed) ? parsed : Object.entries(parsed)
  for (const [k, v] of entries) sessionMap.set(k, v)
  log(chalk.dim(`Restored ${sessionMap.size} session mapping(s) from previous clock-in`))
} catch { /* no file or invalid — start fresh */ }

/** Persist session map to disk (fire-and-forget) */
function persistSessionMap() {
  try {
    mkdirSync(SESSION_MAP_DIR, { recursive: true })
    writeFileSync(SESSION_MAP_FILE, JSON.stringify([...sessionMap]), 'utf-8')
  } catch (err) {
    log(chalk.yellow(`[session] Failed to persist session map to ${SESSION_MAP_FILE}: ${err?.message || err}`))
  }
}

// Track active command processes PER SESSION for concurrent conversation support.
// Key: sessionId, Value: { child, commandId }. Different clients (web, Telegram)
// use different sessionIds and can run in parallel without killing each other.
const activeChildren = new Map()

// ── History Fetch from Chat Bridge (fallback when --resume unavailable) ──────
// Cloud agents use fetchHistoryFromChatBridge to restore context after restart.
// Local-host now does the same: when --resume is not available, fetch conversation
// history from Chat Bridge DB and inject it as system prompt context.
const sessionHistorySynced = new Set()

/**
 * Parse a VO sessionId (agentId--userId--conversationId) into parts.
 * NOTE: agentId and userId are sanitized (dots→dashes) by buildSessionId().
 * Use metadata.agentHandle / metadata.userId for original values.
 */
function parseSessionId(sessionId) {
  const parts = (sessionId || '').split('--')
  return {
    agentId: parts[0] || '',
    userId: parts[1] || '',
    conversationId: parts[2] || null,
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUUID(s) { return typeof s === 'string' && UUID_RE.test(s) }

/**
 * Fetch conversation history from Chat Bridge for a given session.
 * Returns a formatted string suitable for --append-system-prompt injection.
 * Returns empty string if no history or fetch fails.
 *
 * Two-tier strategy:
 *  1. Primary: conversationId (UUID) → GET /api/conversations/{id}/messages
 *  2. Fallback: agentHandle + userId → GET /api/agents/{id}/conversations → latest → messages
 *
 * @param {string} sessionId - VO sessionId (sanitized)
 * @param {object} metadata - Original unsanitized values from message metadata
 * @param {string} [metadata.agentHandle] - Original FQDN (e.g. "claude.aladdin.office.xyz")
 * @param {string} [metadata.userId] - Original userId (e.g. "telegram:2082362824")
 * @param {string} [metadata.conversationId] - Original conversationId (UUID)
 */
async function fetchHistoryForPrompt(sessionId, metadata = {}) {
  if (!sessionId) return ''
  // Only fetch once per session to avoid repeated slow requests
  if (sessionHistorySynced.has(sessionId)) return ''
  sessionHistorySynced.add(sessionId)

  const chatBridgeUrl =
    process.env.CHAT_BRIDGE_HTTP_URL ||
    process.env.CHAT_BRIDGE_URL ||
    'https://chatbridge.aladdinagi.xyz'

  // Resolve conversationId: prefer metadata (original), fall back to sessionId parse
  const parsed = parseSessionId(sessionId)
  const conversationId = metadata.conversationId || (isUUID(parsed.conversationId) ? parsed.conversationId : null)

  // ── Primary path: fetch messages directly by conversationId ──────────────
  if (conversationId) {
    try {
      const url = `${chatBridgeUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=80`
      log(chalk.gray(`[history-sync] Fetching messages for conversation ${conversationId.slice(0, 8)}...`))
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        const data = await response.json()
        const messages = Array.isArray(data.messages) ? data.messages : []
        const result = formatHistoryForPrompt(messages)
        if (result) {
          log(chalk.green(`[history-sync] Loaded ${messages.length} messages from conversation ${conversationId.slice(0, 8)}`))
          return result
        }
      } else if (response.status === 404) {
        log(chalk.gray(`[history-sync] Conversation ${conversationId.slice(0, 8)} not in DB yet (new conversation)`))
      }
    } catch (error) {
      log(chalk.yellow(`[history-sync] Primary fetch failed: ${error?.message || error}`))
    }
  }

  // ── Fallback: list conversations for agent+user, then fetch latest ──────
  const agentHandle = metadata.agentHandle || argv.agent
  const userId = metadata.userId
  if (agentHandle && userId) {
    try {
      const listParams = new URLSearchParams({ userId, limit: '1' })
      const listUrl = `${chatBridgeUrl}/api/agents/${encodeURIComponent(agentHandle)}/conversations?${listParams}`
      log(chalk.gray(`[history-sync] Falling back to conversation list for ${agentHandle}/${userId.slice(0, 20)}...`))
      const listResponse = await fetch(listUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (listResponse.ok) {
        const listData = await listResponse.json()
        const conversations = Array.isArray(listData.conversations) ? listData.conversations : []
        if (conversations.length > 0 && conversations[0].id) {
          const latestConvId = conversations[0].id
          const msgUrl = `${chatBridgeUrl}/api/conversations/${encodeURIComponent(latestConvId)}/messages?limit=80`
          const msgResponse = await fetch(msgUrl, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5000),
          })
          if (msgResponse.ok) {
            const msgData = await msgResponse.json()
            const messages = Array.isArray(msgData.messages) ? msgData.messages : []
            const result = formatHistoryForPrompt(messages)
            if (result) {
              log(chalk.green(`[history-sync] Loaded ${messages.length} messages via fallback (conv ${latestConvId.slice(0, 8)})`))
              return result
            }
          }
        }
      }
    } catch (error) {
      log(chalk.yellow(`[history-sync] Fallback fetch failed: ${error?.message || error}`))
    }
  }

  log(chalk.gray(`[history-sync] No history available for session ${sessionId.slice(0, 30)}`))
  return ''
}

/**
 * Convert an array of message objects into a formatted string for system prompt injection.
 * Returns empty string if no valid turns found.
 */
function formatHistoryForPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''

  const turns = messages
    .filter(msg => msg.content && ['user', 'assistant'].includes(msg.role))
    .slice(-40) // Keep last 40 turns to avoid token overflow
    .map(msg => `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${
      typeof msg.content === 'string' ? msg.content.slice(0, 2000) : '[complex content]'
    }`)

  if (turns.length === 0) return ''

  return `\n\n## Previous Conversation Context\nThe following is the recent conversation history from this session. Continue naturally from where we left off.\n\n${turns.join('\n\n')}`
}

// ── System Prompt & MCP (First-Class Citizen) ──────────────────────────────
// Built on connect, cached for the lifetime of the connection.
let cachedSystemPrompt = null
let mcpConfigPath = null

/**
 * Build the system prompt by fetching from Chat Bridge.
 * Chat Bridge has access to Registry, promptAssembler, tool manuals, etc.
 * This avoids needing monorepo-local imports (../prompt/index.mjs) that
 * don't exist in the npm package.
 *
 * Falls back to a minimal default prompt if chat-bridge is unreachable.
 */
async function buildAgentSystemPrompt() {
  const agentHandle = argv.agent
  if (!agentHandle || agentHandle === 'pending') return null

  const officeId = agentHandle.split('.').slice(1).join('.')

  // Method 1: Fetch from Chat Bridge API (works in npm package)
  const chatBridgeUrl =
    process.env.CHAT_BRIDGE_HTTP_URL ||
    process.env.CHAT_BRIDGE_URL ||
    'https://chatbridge.aladdinagi.xyz'

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const res = await fetch(`${chatBridgeUrl}/api/cli/system-prompt/${encodeURIComponent(agentHandle)}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timeout)

    if (res.ok) {
      const data = await res.json()
      const prompt = data.prompt || data.systemPrompt || null
      if (prompt && prompt.length > 100) {
        log(chalk.green(`System prompt fetched from Chat Bridge (${prompt.length} chars)`))
        return prompt
      }
    }
  } catch (err) {
    log(chalk.dim(`Chat Bridge prompt fetch failed: ${err.message}`))
  }

  // Method 2: Try local monorepo import (works in dev, not in npm package)
  try {
    const { buildSystemPrompt } = await import('../prompt/index.mjs')
    const prompt = await buildSystemPrompt({
      agentHandle,
      officeId,
      workspaceRoot: workspace,
      platform: `${os.platform()}-${os.arch()}`,
    })
    if (prompt && prompt.length > 100) {
      log(chalk.green(`System prompt built locally (${prompt.length} chars)`))
      return prompt
    }
  } catch {
    // Expected in npm package — no local prompt module
  }

  log(chalk.yellow('Using default system prompt'))
  return null
}

/**
 * Register VO MCP server with Claude Code using `claude mcp add`.
 * This is the correct way per https://code.claude.com/docs/en/mcp
 * The server is registered locally and `claude -p` auto-loads it.
 */
async function registerMcpServer() {
  try {
    const agentHandle = argv.agent
    const officeId = agentHandle.split('.').slice(1).join('.')
    // Use the lightweight MCP server bundled with the npm package.
    // It fetches tool schemas from Chat Bridge and proxies all calls via HTTP,
    // so it doesn't need the 150+ monorepo files that the full MCP server requires.
    const mcpServerPath = path.resolve(__dirname, 'mcp-server-lite.cjs')

    const chatBridgeUrl = process.env.CHAT_BRIDGE_URL ||
      process.env.CHAT_BRIDGE_BASE_URL ||
      'https://chatbridge.aladdinagi.xyz'

    // Use agent-specific MCP name to avoid conflicts when multiple agents run
    const mcpName = `vo-${agentHandle.split('.')[0]}`

    // Remove existing (idempotent)
    // 🔧 Use async exec instead of execSync to avoid blocking the event loop.
    // execSync freezes the event loop for up to 10s, preventing WebSocket pong
    // responses. Node.js processes timer callbacks (heartbeat) before I/O
    // callbacks (pong) after unblock, so the heartbeat sees isAlive=false and
    // terminates the connection — causing an infinite reconnection loop.
    try {
      await execAsync(`claude mcp remove ${mcpName}`, { timeout: 5000 })
    } catch { /* ignore — might not exist */ }

    // Register using `claude mcp add-json --scope user` — the only scope that works
    // with `claude -p` headless mode. Per-agent name avoids conflicts.
    const serverConfig = JSON.stringify({
      type: 'stdio',
      command: 'node',
      args: [mcpServerPath],
      env: {
        CHAT_BRIDGE_URL: chatBridgeUrl,
        CANONICAL_AGENT_HANDLE: agentHandle,
        REGISTRY_OFFICE_ID: officeId,
        WORKSPACE_ROOT: workspace,
      },
    })

    await execAsync(`claude mcp add-json ${mcpName} '${serverConfig.replace(/'/g, "'\\''")}' --scope user`, {
      timeout: 10000,
    })
    log(chalk.green(`MCP server '${mcpName}' registered (--scope user)`))
    return mcpName
  } catch (err) {
    log(chalk.yellow(`Failed to register MCP server: ${err.message}`))
    return false
  }
}

/**
 * Unregister VO MCP server on clock-out.
 */
function unregisterMcpServer() {
  try {
    const mcpName = `vo-${argv.agent.split('.')[0]}`
    execSync(`claude mcp remove ${mcpName}`, { stdio: 'ignore', timeout: 5000 })
    log(chalk.dim(`MCP server '${mcpName}' unregistered`))
  } catch { /* ignore */ }
}

// ── Channel resolution ─────────────────────────────────────────────────────

/**
 * Resolve message channel from platformInfo / metadata / sessionId.
 * Returns { type, color, sender, chatId } for display formatting.
 */
function resolveChannel(message) {
  const platformInfo = message.platformInfo || {}
  const meta = message.metadata || {}
  const source = meta.source || platformInfo.clientType || ''
  const sessionId = message.sessionId || ''

  if (source.includes('telegram')) {
    const from = meta.telegram?.from
    const name = from?.username ? `@${from.username}` : from?.firstName || 'user'
    return { type: 'Telegram', color: 'blue', sender: name, chatId: platformInfo.chatId }
  }
  if (source.includes('slack')) {
    const channel = meta.slack?.channelId || platformInfo.channelId || ''
    const user = meta.slack?.username || 'user'
    return { type: 'Slack', color: 'magenta', sender: channel ? `#${channel} — ${user}` : user, chatId: null }
  }
  if (source.includes('discord')) {
    return { type: 'Discord', color: 'blueBright', sender: meta.discord?.username || 'user', chatId: null }
  }
  if (source.includes('feishu') || source.includes('lark')) {
    return { type: 'Feishu', color: 'cyan', sender: meta.feishu?.username || 'user', chatId: null }
  }
  if (source.includes('wecom') || source.includes('wechat') || source.includes('whatsapp')) {
    const label = source.includes('whatsapp') ? 'WhatsApp' : 'WeChat'
    return { type: label, color: 'green', sender: 'user', chatId: null }
  }
  if (sessionId.includes('office-wide')) {
    const senderParts = sessionId.split('--')
    return { type: 'Office Chat', color: 'greenBright', sender: senderParts[0] || 'colleague', chatId: null }
  }
  // Default: Web dialog
  const userId = sessionId.split('--')[1] || 'user'
  return { type: 'Web', color: 'cyanBright', sender: userId.slice(0, 20), chatId: null }
}

// ── Message handling ───────────────────────────────────────────────────────

function sendJSON(payload) {
  if (wsRef && wsRef.readyState === WebSocket.OPEN) {
    wsRef.send(JSON.stringify(payload))
  } else if (gracefulDisconnect) {
    // Buffer during graceful disconnect — flushed after reconnect
    if (pendingSendBuffer.length < MAX_PENDING_BUFFER) {
      pendingSendBuffer.push(JSON.stringify(payload))
    }
  }
}

function truncateText(value, max = 1200) {
  if (typeof value !== 'string') return value
  if (value.length <= max) return value
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`
}

function compactToolValue(value) {
  if (value == null) return value
  if (typeof value === 'string') return truncateText(value, 1200)
  try {
    return truncateText(JSON.stringify(value), 1200)
  } catch {
    return truncateText(String(value), 1200)
  }
}

function sendHostMeta(ws) {
  const meta = {
    type: 'hostMeta',
    hostId,
    timestamp: new Date().toISOString(),
    workspace,
    features: {
      localHost: true,
      provider: argv.provider,
      platform: `${os.platform()}-${os.arch()}`,
      streaming: true,
    },
  }
  ws.send(JSON.stringify(meta))
  log(chalk.green('Sent hostMeta'))
}

/**
 * Handle an incoming message from manager-service.
 * For command/userMessage: spawn `claude -p` with stream-json output,
 * parse the NDJSON stream, and emit streaming events back to the manager.
 */
async function handleMessage(message) {
  const { type } = message

  if (type === 'command' || type === 'userMessage') {
    // Normalize
    let text = message.command || message.content || ''

    // ── Attachment / image handling ──────────────────────────────────────
    // Save any attached images or files to temp dir so Claude Code can
    // read them via its built-in Read tool (which supports images natively).
    const attachmentPaths = []
    try {
      const images = Array.isArray(message.images) ? message.images : []
      const attachments = Array.isArray(message.attachments) ? message.attachments : []

      if (images.length || attachments.length) {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vo-attach-'))

        // Inline base64 images (e.g. from Telegram photos, screenshots)
        // Telegram sends: { type: 'base64', media_type: 'image/jpeg', data: '...' }
        // Web Dialog sends: { base64: '...', mimeType: 'image/png' }
        for (const img of images) {
          const b64 = img.base64 || img.data
          if (!b64) continue
          const mime = img.mimeType || img.media_type || 'image/png'
          const ext = mime.split('/')[1] || 'png'
          const fpath = path.join(tmpDir, `image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
          writeFileSync(fpath, Buffer.from(b64, 'base64'))
          attachmentPaths.push(fpath)
          log(chalk.cyan(`[attach] Saved image → ${fpath}`))
        }

        // File attachments (with URL, dataUrl, or raw base64)
        for (const att of attachments) {
          const fname = att.name || `file-${Date.now()}`
          const fpath = path.join(tmpDir, fname)
          if (att.dataUrl && typeof att.dataUrl === 'string') {
            // dataUrl format: "data:image/png;base64,iVBOR..."
            const match = att.dataUrl.match(/^data:[^;]*;base64,(.+)$/)
            if (match) {
              writeFileSync(fpath, Buffer.from(match[1], 'base64'))
              attachmentPaths.push(fpath)
              log(chalk.cyan(`[attach] Saved file (dataUrl) → ${fpath}`))
            } else {
              log(chalk.yellow(`[attach] Unrecognized dataUrl format for ${fname}`))
            }
          } else if (att.base64) {
            writeFileSync(fpath, Buffer.from(att.base64, 'base64'))
            attachmentPaths.push(fpath)
            log(chalk.cyan(`[attach] Saved file → ${fpath}`))
          } else if (att.url) {
            // Append URL reference — Claude Code can use WebFetch if needed
            attachmentPaths.push(`URL:${att.url}`)
            log(chalk.cyan(`[attach] File URL → ${att.url}`))
          }
        }
      }
    } catch (err) {
      log(chalk.yellow(`[attach] Failed to process attachments: ${err.message}`))
    }

    // Append file paths to user message so Claude Code knows about them
    if (attachmentPaths.length) {
      const fileRefs = attachmentPaths
        .map(p => p.startsWith('URL:') ? p : `File: ${p}`)
        .join('\n')
      text = text
        ? `${text}\n\n[Attached files — use the Read tool to view them]\n${fileRefs}`
        : `Please analyze the following attached files:\n${fileRefs}`
    }

    if (!text) return

    const sessionId = message.sessionId || null
    const commandId = message.commandId || message.messageId || `cmd-${Date.now()}`

    const channel = resolveChannel(message)

    // --channel filter: skip messages not matching the requested channel
    if (argv.channel && !channel.type.toLowerCase().includes(argv.channel.toLowerCase())) return

    const badge = chalk[channel.color](`[${channel.type}]`)
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const sender = chalk.dim(channel.sender)
    info(`${badge} ${chalk.dim(time)}  ${sender}`)
    info(`  ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`)

    // Kill previous command for THIS SESSION only. Other sessions continue in parallel.
    const prev = sessionId ? activeChildren.get(sessionId) : null
    if (prev?.child) {
      log(chalk.dim(`[${sessionId}] Killing previous command for same session`))
      sendJSON({
        type: 'streaming.aborted',
        sessionId,
        commandId: prev.commandId,
        reason: 'replaced-by-new-message',
        abortedAt: new Date().toISOString(),
      })
      try { prev.child.kill('SIGTERM') } catch { /* ignore */ }
      activeChildren.delete(sessionId)
    }

    // Build CLI args
    const cmd = argv['cli-command'] || providerConfig.command
    const args = [...providerConfig.baseArgs]
    if (model && providerConfig.modelFlag) {
      args.push(providerConfig.modelFlag, model)
    }
    // Resume conversation if we have a Claude session_id for this VO session
    const claudeSessionId = sessionId ? sessionMap.get(sessionId) : null
    const attemptedResume = !!(claudeSessionId && providerConfig.resumeFlag)
    if (claudeSessionId && providerConfig.resumeFlag) {
      args.push(providerConfig.resumeFlag, claudeSessionId)
      log(chalk.green(`[session] Resuming: ${sessionId} → ${claudeSessionId}`))
    } else if (sessionId) {
      log(chalk.yellow(`[session] No resume binding for ${sessionId} (map size: ${sessionMap.size})`))
    }

    // ── History injection fallback ──────────────────────────────────────────
    // When --resume is not available (no session binding, e.g. after chat-bridge
    // restart or clock-out/in), fetch conversation history from Chat Bridge DB
    // and inject it into the system prompt. This mirrors what the cloud adapter
    // (host-adapter-claude-agent.js) does via fetchHistoryFromChatBridge().
    // Pre-fetch here so it's available for both initial run and retry path.
    let historyContext = ''
    if (!attemptedResume && sessionId) {
      historyContext = await fetchHistoryForPrompt(sessionId, {
        agentHandle: argv.agent || message.metadata?.agentHandle,
        userId: message.metadata?.userId,
        conversationId: message.metadata?.conversationId,
      })
      if (historyContext) {
        log(chalk.green(`[history-sync] Fetched conversation history for context injection`))
      }
    }

    // System prompt + platform context injection.
    // shell: false — no escaping needed, args passed directly.
    let systemPromptTmpFile = null
    const platformInfo = message.platformInfo || null
    let promptToInject = cachedSystemPrompt || ''

    // Inject history context when --resume is not available
    if (historyContext) {
      promptToInject += historyContext
    }
    
    // Append platform context so agent knows the message source (Telegram/Slack/Web)
    if (platformInfo?.clientType) {
      const clientLabel = platformInfo.clientType.replace(/-/g, ' ')
      promptToInject += `\n\n## Current Platform\nYou are responding via ${clientLabel}.`
      if (platformInfo.chatId) promptToInject += ` Chat ID: ${platformInfo.chatId}.`
      if (platformInfo.platformContext) promptToInject += `\n${platformInfo.platformContext}`
      info(chalk.dim(`[platform] ${platformInfo.clientType}${platformInfo.chatId ? ` (chat: ${platformInfo.chatId})` : ''}`))
    }
    
    if (promptToInject) {
      args.push('--append-system-prompt', promptToInject)
    }
    // MCP: no --mcp-config flag needed. The VO MCP server is registered via
    // `claude mcp add` during clock-in, so `claude -p` auto-loads it.
    // See: https://code.claude.com/docs/en/mcp
    // User message as last positional argument (raw, no escaping needed with shell: false)
    args.push(text)
    // Pre-build args without --resume for use in retry (remove resumeFlag + its value).
    // If resume fails (expired session → exit code 1), we retry with these args.
    const argsWithoutResume = attemptedResume
      ? args.filter((a, i, arr) => a !== providerConfig.resumeFlag && arr[i - 1] !== providerConfig.resumeFlag)
      : null
    let sessionRetried = false

    info(chalk.blue(`Running: ${cmd} ${args.slice(0, 5).join(' ')}... [${args.length} args]`))
    if (process.env.ANTHROPIC_API_KEY) {
      info(chalk.dim(`  Auth: Claude login session (stripped inherited API key from env)`))
    } else {
      info(chalk.dim(`  Auth: Claude login session`))
    }

    // 1. Send streaming.started
    sendJSON({
      type: 'streaming.started',
      sessionId,
      commandId,
      status: 'running',
      startedAt: new Date().toISOString(),
    })

    // Heartbeat: Send periodic streaming.heartbeat during long-running claude -p execution.
    // This prevents WS proxies (Cloudflare 100s, ALB 60s) from killing idle connections
    // when Claude Code is thinking but not emitting any streaming tokens.
    const HEARTBEAT_INTERVAL_MS = 25_000 // 25s — below Cloudflare/ALB idle timeouts
    const heartbeatTimer = setInterval(() => {
      sendJSON({
        type: 'streaming.heartbeat',
        sessionId,
        commandId,
        timestamp: Date.now(),
      })
    }, HEARTBEAT_INTERVAL_MS)

    // 2. Spawn the CLI process
    // shell: false — args are passed directly to the process as an array,
    // avoiding ALL shell interpretation issues. The command is resolved via
    // PATH by Node's child_process (works for npm global bins).
    let child
    try {
      // Strip ANTHROPIC_API_KEY from child env so Claude Code CLI uses the
      // user's local login session (claude login / Max subscription) instead
      // of consuming API credits from a shared key that may have been loaded
      // by load-aladdin-env.sh or other infra scripts in the same shell.
      const childEnv = { ...process.env }
      delete childEnv.ANTHROPIC_API_KEY

      child = spawn(cmd, args, {
        cwd: workspace,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
      if (sessionId) activeChildren.set(sessionId, { child, commandId })
    } catch (err) {
      log(chalk.red(`Failed to spawn CLI: ${err.message}`))
      sendJSON({ type: 'result', sessionId, commandId, stdout: '', stderr: `Failed to start ${argv.provider}: ${err.message}`, exitCode: 1 })
      return
    }

    // 3. Parse NDJSON stream from stdout
    const rl = createInterface({ input: child.stdout })
    let fullText = ''
    let resultSessionId = null
    let isApiError = false  // Track if this session encountered an API/auth error
    const activeToolsByIndex = new Map()
    const activeToolsById = new Map()
    const finalizedToolIds = new Set()
    const completedToolActions = []
    const activeThinkingByIndex = new Map()
    const completedThinkingBlocks = []

    // 🚀 PERF v2: thinking_delta is no longer sent to frontend.
    // Only thinking_start and thinking_end are transmitted.
    // Text is still accumulated locally in activeThinkingByIndex for completedThinkingBlocks metadata.

    const emitToolStart = ({ toolUseId, toolName, input, timestamp }) => {
      const normalizedId = toolUseId || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const startedAt = Number.isFinite(timestamp) ? timestamp : Date.now()
      // Normalize tool names for consistent frontend display across all CLI providers
      const normalized = normalizeToolName(toolName || 'tool')
      activeToolsById.set(normalizedId, { toolName: normalized, input, startedAt })
      sendJSON({
        type: 'tool_event',
        sessionId,
        commandId,
        event: {
          eventType: 'tool_start',
          toolName: normalized,
          toolUseId: normalizedId,
          input,
          status: 'running',
          timestamp: startedAt,
        },
      })
    }

    const emitToolEnd = ({ toolUseId, toolName, input, result, error, timestamp, force = false }) => {
      if (!toolUseId) return
      if (finalizedToolIds.has(toolUseId) && !force) return
      finalizedToolIds.add(toolUseId)
      const endedAt = Number.isFinite(timestamp) ? timestamp : Date.now()
      const rawTool = toolName || activeToolsById.get(toolUseId)?.toolName || 'tool'
      const resolvedTool = normalizeToolName(rawTool)
      const resolvedInput = input ?? activeToolsById.get(toolUseId)?.input
      const status = error ? 'error' : 'completed'
      const compactResult = compactToolValue(result)
      const compactError = compactToolValue(error)
      sendJSON({
        type: 'tool_event',
        sessionId,
        commandId,
        event: {
          eventType: 'tool_end',
          toolName: resolvedTool,
          toolUseId,
          input: resolvedInput,
          result: compactResult,
          error: compactError,
          status,
          timestamp: endedAt,
        },
      })
      const actionRecord = {
        id: toolUseId,
        toolName: resolvedTool,
        status,
        input: resolvedInput,
        result: compactResult,
        error: compactError,
        timestamp: endedAt,
      }
      const existingIndex = completedToolActions.findIndex((entry) => entry.id === toolUseId)
      if (existingIndex >= 0) completedToolActions[existingIndex] = actionRecord
      else completedToolActions.push(actionRecord)
      activeToolsById.delete(toolUseId)
    }

    const lineHandler = (line) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line)
        const streamEvent = event?.type === 'stream_event' ? event.event : null
        const blockIndexRaw = streamEvent?.index ?? streamEvent?.content_block_index
        const blockIndex = Number.isInteger(blockIndexRaw) ? blockIndexRaw : null
        const now = Date.now()

        // Stream event with text delta → send streaming.delta
        if (streamEvent?.delta?.type === 'text_delta') {
          const chunk = streamEvent.delta.text || ''
          if (chunk) {
            fullText += chunk
            sendJSON({ type: 'streaming.delta', sessionId, commandId, chunk })
            process.stdout.write(chunk) // local echo
          }
          return
        }

        // Input JSON deltas — accumulate tool input as it streams in
        // Claude CLI sends tool input progressively: content_block_start has input: {},
        // then input_json_delta events carry the actual JSON. Without accumulating these,
        // tool indicators show "(no command)" because input is empty.
        if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'input_json_delta') {
          const partialJson = streamEvent.delta.partial_json || ''
          if (blockIndex !== null) {
            const toolState = activeToolsByIndex.get(blockIndex)
            if (toolState) {
              // Accumulate raw JSON string — we'll parse the complete object later
              if (!toolState._inputJsonBuffer) toolState._inputJsonBuffer = ''
              toolState._inputJsonBuffer += partialJson
              // Try to parse accumulated JSON to update input (best-effort)
              try {
                toolState.input = JSON.parse(toolState._inputJsonBuffer)
              } catch {
                // Not complete JSON yet — that's fine, keep accumulating
              }
            }
          }
          return
        }

        // Citations delta — ignore silently (citations are embedded in final text)
        if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'citations_delta') {
          return
        }

        // Thinking deltas — 🚀 PERF: batched every 80ms to reduce WebSocket pressure
        if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'thinking_delta') {
          const deltaText = streamEvent.delta.thinking || streamEvent.delta.text || ''
          if (!deltaText) return
          const thinkingState = blockIndex !== null ? activeThinkingByIndex.get(blockIndex) : null
          const thinkingId = thinkingState?.id || `thinking-${now}`
          if (thinkingState) {
            thinkingState.text = `${thinkingState.text || ''}${deltaText}`
          } else if (blockIndex !== null) {
            activeThinkingByIndex.set(blockIndex, {
              id: thinkingId,
              text: deltaText,
              startedAt: now,
            })
          }
          // 🚀 PERF v2: Only accumulate locally, do NOT send to frontend
          return
        }

        // Tool / thinking block starts
        if (streamEvent?.type === 'content_block_start') {
          const block = streamEvent.content_block
          if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
            const thinkingId = block.id || `thinking-${now}-${Math.random().toString(36).slice(2, 8)}`
            if (blockIndex !== null) {
              activeThinkingByIndex.set(blockIndex, {
                id: thinkingId,
                text: '',
                startedAt: now,
              })
            }
            sendJSON({
              type: 'thinking_event',
              sessionId,
              commandId,
              event: {
                eventType: 'thinking_start',
                thinkingId,
                timestamp: now,
              },
            })
            return
          }

          // All tool-like block types: tool_use (client), server_tool_use (Anthropic server),
          // mcp_tool_use, and result blocks that appear as content_block_start in stream-json.
          // The original Claude CLI sets "tool-input" spinner state for all of these.
          const TOOL_BLOCK_TYPES = new Set([
            'tool_use', 'server_tool_use', 'mcp_tool_use',
            'web_search_tool_result', 'web_fetch_tool_result',
            'code_execution_tool_result', 'bash_code_execution_tool_result',
            'text_editor_code_execution_tool_result', 'tool_search_tool_result',
            'mcp_tool_result', 'container_upload',
          ])
          if (TOOL_BLOCK_TYPES.has(block?.type)) {
            // For server_tool_use, the tool name is in block.name (e.g. "web_search")
            // For result blocks, derive name from block type itself
            const rawName = block.name || block.type
            const toolUseId = block.id || block.tool_use_id || `tool-${now}-${Math.random().toString(36).slice(2, 8)}`
            if (blockIndex !== null) {
              activeToolsByIndex.set(blockIndex, {
                toolUseId,
                toolName: rawName,
                input: block.input || {},
              })
            }
            emitToolStart({
              toolUseId,
              toolName: rawName,
              input: block.input || {},
              timestamp: now,
            })
          }

          // Compaction events — notify frontend that context is being compressed
          if (block?.type === 'compaction') {
            emitToolStart({
              toolUseId: block.id || `compaction-${now}`,
              toolName: 'Compaction',
              input: {},
              timestamp: now,
            })
          }
          return
        }

        // Tool / thinking block stops
        if (streamEvent?.type === 'content_block_stop') {
          if (blockIndex !== null) {
            const thinkingState = activeThinkingByIndex.get(blockIndex)
            if (thinkingState) {
              const elapsedMs = Math.max(0, now - (thinkingState.startedAt || now))
              sendJSON({
                type: 'thinking_event',
                sessionId,
                commandId,
                event: {
                  eventType: 'thinking_end',
                  thinkingId: thinkingState.id,
                  timestamp: now,
                  elapsedMs,
                  text: thinkingState.text || '',  // full thinking text for on-demand expand
                },
              })
              completedThinkingBlocks.push({
                id: thinkingState.id,
                text: thinkingState.text || '',
                elapsedMs,
              })
              activeThinkingByIndex.delete(blockIndex)
              return
            }

            const toolState = activeToolsByIndex.get(blockIndex)
            if (toolState?.toolUseId) {
              emitToolEnd({
                toolUseId: toolState.toolUseId,
                toolName: toolState.toolName,
                input: toolState.input,
                timestamp: now,
              })
              activeToolsByIndex.delete(blockIndex)
              return
            }
          }
          return
        }

        // Final result message (type=result from claude -p --output-format stream-json)
        if (event.type === 'result') {
          resultSessionId = event.session_id || null
          // Detect API errors in result (e.g. 403 Forbidden, auth failures)
          if (event.is_error || event.isApiErrorMessage) {
            isApiError = true
          }
          if (event.result && !fullText) {
            fullText = event.result
          }
          return
        }

        // Message event with assistant content
        if (event.type === 'message' && event.message?.role === 'assistant') {
          const content = event.message.content || []
          // Detect API error messages (synthetic responses from Claude CLI on auth/API failures)
          if (event.message.isApiErrorMessage || event.isApiErrorMessage || event.error) {
            isApiError = true
          }
          for (const block of content) {
            // Extract text blocks
            if (block.type === 'text' && block.text) {
              if (!fullText) fullText = block.text
            }
            // Extract complete tool input — the assistant message contains the
            // fully accumulated input (unlike content_block_start which has {}).
            // This applies to tool_use, server_tool_use, and mcp_tool_use blocks.
            const isToolBlock = block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use'
            if (isToolBlock && block.id && block.input) {
              const existing = activeToolsById.get(block.id)
              if (existing && (!existing.input || Object.keys(existing.input).length === 0)) {
                existing.input = block.input
                // Re-emit tool_start with complete input so frontend can display details
                sendJSON({
                  type: 'tool_event',
                  sessionId,
                  commandId,
                  event: {
                    eventType: 'tool_start',
                    toolName: existing.toolName,
                    toolUseId: block.id,
                    input: block.input,
                    status: 'running',
                    timestamp: existing.startedAt || now,
                  },
                })
              }
            }
          }
          return
        }

        // Tool result blocks appear in user role messages in Claude stream-json.
        // Use them to close tool lifecycles with concrete result payloads.
        if (event.type === 'message' && event.message?.role === 'user') {
          const content = event.message.content || []
          for (const block of content) {
            if (block?.type !== 'tool_result') continue
            const toolUseId = block.tool_use_id || block.toolUseId
            let resultPayload = block.content
            if (Array.isArray(resultPayload)) {
              resultPayload = resultPayload
                .map((item) => (typeof item?.text === 'string' ? item.text : typeof item === 'string' ? item : JSON.stringify(item)))
                .join('\n')
            }
            if (resultPayload && typeof resultPayload !== 'string') {
              try {
                resultPayload = JSON.stringify(resultPayload)
              } catch {
                resultPayload = String(resultPayload)
              }
            }
            emitToolEnd({
              toolUseId,
              result: resultPayload || '',
              timestamp: now,
              force: true,
            })
          }
          return
        }

        // System events — forward plan mode, hooks, and other system subtypes
        // These are top-level events (not wrapped in stream_event) that the CLI
        // emits in --verbose stream-json mode for UI state changes.
        if (event.type === 'system') {
          const subtype = event.subtype
          // Plan mode transitions — let frontend know agent entered/exited planning
          if (subtype === 'plan_mode' || subtype === 'plan_mode_exit' || subtype === 'plan_mode_reentry') {
            sendJSON({ type: 'system_event', sessionId, commandId, event: { subtype, timestamp: now } })
            return
          }
          // Hook lifecycle — show user that hooks are running
          if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
            sendJSON({ type: 'system_event', sessionId, commandId, event: { subtype, hookName: event.hook_name, timestamp: now } })
            return
          }
          // Task/agent notifications (subagent spawned, progress, etc.)
          if (subtype === 'task_notification' || subtype === 'task_progress') {
            sendJSON({ type: 'system_event', sessionId, commandId, event: { subtype, message: event.message, timestamp: now } })
            return
          }
          // MCP progress
          if (subtype === 'mcp_message' || subtype === 'mcp_progress') {
            sendJSON({ type: 'system_event', sessionId, commandId, event: { subtype, message: event.message, timestamp: now } })
            return
          }
          // Context compaction boundaries
          if (subtype === 'compact_boundary' || subtype === 'microcompact_boundary') {
            sendJSON({ type: 'system_event', sessionId, commandId, event: { subtype, timestamp: now } })
            return
          }
          return
        }
      } catch {
        // Not JSON or unrecognized format — ignore
      }
    }
    rl.on('line', lineHandler)

    // stderr → log
    const stderrHandler = (chunk) => {
      const text = chunk.toString()
      if (text.trim()) {
        log(chalk.dim(`[stderr] ${text.trim().slice(0, 200)}`))
        // Detect API/auth errors from stderr (e.g. "API Error: 403", "Failed to authenticate")
        if (/API Error:\s*4\d{2}|Failed to authenticate|forbidden|Request not allowed/i.test(text)) {
          isApiError = true
        }
      }
    }
    child.stderr.on('data', stderrHandler)

    // 4. On process exit, send completion events
    const closeHandler = async (code, signal) => {
      clearInterval(heartbeatTimer) // Stop heartbeat — task is done
      if (sessionId && activeChildren.get(sessionId)?.child === child) activeChildren.delete(sessionId)

      // Clean up system prompt temp file
      if (systemPromptTmpFile) {
        try { unlinkSync(systemPromptTmpFile) } catch { /* ignore */ }
      }

      // SESSION RETRY: If --resume failed (exit code 1, no response produced), clear the
      // stale binding and retry without --resume so the user gets a fresh session.
      // This happens when a session expires on Anthropic's side (Claude's ~/.claude/ entries
      // don't live forever) or when the session data is from a different machine/workspace.
      //
      // IMPORTANT: Do NOT treat signal kills (SIGTERM/SIGKILL) as resume failures!
      // When chat-bridge/MHS restarts, the WS drops and we kill all active children.
      // In that case code=null and signal='SIGTERM'. The session binding is still valid
      // on Anthropic's servers — deleting it would prevent resume on the next message.
      // Signal kill (e.g. SIGTERM from WS disconnect) — preserve session binding for next resume.
      // Also skip retry: WS is down so we can't send results back anyway.
      // NOTE: Node.js sometimes reports SIGTERM as code=143 (128+15) with signal=null,
      // so we also check for exit codes >= 128 which indicate signal termination.
      const killedBySignal = signal || (code !== null && code >= 128)
      if (killedBySignal) {
        if (attemptedResume) {
          log(chalk.dim(`[session] CLI killed by ${signal || `signal(code=${code})`}, preserving session binding for ${sessionId}`))
        }
        // Send streaming.completed if WS is still open (edge case)
        if (wsRef && wsRef.readyState === 1) {
          try {
            sendJSON({ type: 'streaming.completed', sessionId, commandId, status: 'cancelled' })
          } catch { /* ignore */ }
        }
        return
      }
      if (code !== 0 && !signal && attemptedResume && !sessionRetried && !fullText) {
        sessionRetried = true
        sessionMap.delete(sessionId)
        persistSessionMap()
        log(chalk.yellow(`[session-retry] --resume failed (exit=${code}), cleared stale binding, retrying without --resume`))
        // Reset streaming state for fresh attempt
        fullText = ''
        resultSessionId = null
        isApiError = false
        activeToolsByIndex.clear()
        activeToolsById.clear()
        finalizedToolIds.clear()
        completedToolActions.length = 0
        activeThinkingByIndex.clear()
        completedThinkingBlocks.length = 0
        // Fetch history from Chat Bridge for context injection on retry
        // (original args had --resume so history wasn't fetched initially)
        let retryArgs = argsWithoutResume
        if (sessionId) {
          try {
            const retryHistory = await fetchHistoryForPrompt(sessionId, {
              agentHandle: argv.agent || message.metadata?.agentHandle,
              userId: message.metadata?.userId,
              conversationId: message.metadata?.conversationId,
            })
            if (retryHistory) {
              // Rebuild args: replace --append-system-prompt value with history-enriched version
              const retryPrompt = (cachedSystemPrompt || '') + retryHistory
              retryArgs = retryArgs.map((a, i, arr) =>
                i > 0 && arr[i - 1] === '--append-system-prompt' ? retryPrompt : a
              )
              log(chalk.green(`[session-retry] Injected conversation history into retry system prompt`))
            }
          } catch (err) {
            log(chalk.yellow(`[session-retry] History fetch failed (continuing without): ${err.message}`))
          }
        }
        // Spawn fresh without --resume (with history context if available)
        const childEnvRetry = { ...process.env }
        delete childEnvRetry.ANTHROPIC_API_KEY
        child = spawn(cmd, retryArgs, { cwd: workspace, env: childEnvRetry, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
        if (sessionId) activeChildren.set(sessionId, { child, commandId })
        log(chalk.blue(`[session-retry] Re-running: ${cmd} ${retryArgs.slice(0, 5).join(' ')}... [${retryArgs.length} args]`))
        // Rewire NDJSON parser + handlers onto the new child
        const rlRetry = createInterface({ input: child.stdout })
        rlRetry.on('line', lineHandler)
        child.stderr.on('data', stderrHandler)
        child.on('close', closeHandler)
        child.on('error', errorHandler)
        return
      }

      // Store Claude session_id for conversation continuity.
      // IMPORTANT: Do NOT save bindings for failed sessions (API errors, auth failures).
      // Resuming a session that only contains an error message causes the next conversation
      // to appear as "new" since there's no meaningful context to resume.
      // Also detect errors from response text (Claude CLI wraps API errors as text content)
      if (!isApiError && fullText && /API Error:\s*4\d{2}|Failed to authenticate|"type":"forbidden"/i.test(fullText)) {
        isApiError = true
      }
      if (resultSessionId && sessionId) {
        if (isApiError) {
          // Remove any existing binding for this session — it's poisoned by the error.
          // Don't use exit code alone: CLI might exit 0 after handling errors gracefully,
          // or non-zero from SIGTERM (when we kill a previous session for the same user).
          if (sessionMap.has(sessionId)) {
            sessionMap.delete(sessionId)
            persistSessionMap()
            log(chalk.yellow(`[session] Cleared binding for ${sessionId} (apiError, code=${code})`))
          } else {
            log(chalk.yellow(`[session] Skipped binding for ${sessionId} (apiError, code=${code})`))
          }
        } else {
          sessionMap.set(sessionId, resultSessionId)
          persistSessionMap()
          log(chalk.green(`[session] Mapped: ${sessionId} → ${resultSessionId} (map size: ${sessionMap.size}, file: ${SESSION_MAP_FILE})`))
        }
      } else if (!resultSessionId && sessionId) {
        // Diagnostic: CLI completed but didn't emit session_id in result event
        log(chalk.yellow(`[session] No session_id in result event (sessionId=${sessionId}, code=${code}, hasText=${!!fullText}, signal=${signal})`))
      } else if (!sessionId) {
        log(chalk.yellow(`[session] No VO sessionId in message — cannot track session (resultSessionId=${resultSessionId})`))
      }

      if (fullText) {
        process.stdout.write('\n')
        info(chalk[channel.color](`[${channel.type}] ←`) + chalk.dim(` ${fullText.slice(0, 120)}${fullText.length > 120 ? '...' : ''}`))
      }

      // Send streaming.completed
      sendJSON({
        type: 'streaming.completed',
        sessionId,
        commandId,
        status: 'completed',
        completedAt: new Date().toISOString(),
      })

      // Send final result
      const contentBlocks = []
      if (completedThinkingBlocks.length > 0) {
        for (const block of completedThinkingBlocks) {
          contentBlocks.push({
            type: 'thinking',
            id: block.id,
            text: block.text || '',
            elapsedMs: typeof block.elapsedMs === 'number' ? block.elapsedMs : undefined,
            _sortTs: Date.now() - (block.elapsedMs || 0),
          })
        }
      }
      if (completedToolActions.length > 0) {
        for (const action of completedToolActions) {
          contentBlocks.push({
            type: 'tool',
            id: action.id,
            name: action.toolName,
            status: action.status,
            input: action.input,
            result: action.result,
            error: action.error,
            _sortTs: action.timestamp || Date.now(),
          })
        }
      }
      if (fullText && fullText.trim()) {
        contentBlocks.push({
          type: 'text',
          id: `text-${Date.now()}`,
          text: fullText.trim(),
          _sortTs: Date.now(),
        })
      }
      contentBlocks.sort((a, b) => (a._sortTs || 0) - (b._sortTs || 0))
      const normalizedContentBlocks = contentBlocks.map(({ _sortTs, ...rest }) => rest)

      try {
        sendJSON({
          type: 'result',
          sessionId,
          commandId,
          stdout: fullText || '(No response)',
          stderr: '',
          exitCode: code || 0,
          metadata: {
            toolActions: completedToolActions.length > 0 ? completedToolActions : undefined,
            thinkingBlocks: completedThinkingBlocks.length > 0 ? completedThinkingBlocks : undefined,
            contentBlocks: normalizedContentBlocks.length > 0 ? normalizedContentBlocks : undefined,
          },
        })
      } catch (err) {
        // Fallback to minimal payload if metadata gets too large for transport.
        sendJSON({
          type: 'result',
          sessionId,
          commandId,
          stdout: fullText || '(No response)',
          stderr: '',
          exitCode: code || 0,
          metadata: {
            thinkingBlocks: completedThinkingBlocks.length > 0 ? completedThinkingBlocks : undefined,
          },
        })
        log(chalk.yellow(`Result metadata fallback used: ${err.message}`))
      }
    }
    child.on('close', closeHandler)

    const errorHandler = (err) => {
      clearInterval(heartbeatTimer) // Stop heartbeat on error
      log(chalk.red(`CLI process error: ${err.message}`))
      if (err.code === 'ENOENT') {
        log(chalk.yellow(`"${cmd}" not found. Install it with: ${providerConfig.installHint}`))
      }
      sendJSON({
        type: 'result',
        sessionId,
        commandId,
        stdout: '',
        stderr: `CLI error: ${err.message}`,
        exitCode: 1,
        metadata: {
          toolActions: completedToolActions.length > 0 ? completedToolActions : undefined,
          thinkingBlocks: completedThinkingBlocks.length > 0 ? completedThinkingBlocks : undefined,
        },
      })
    }
    child.on('error', errorHandler)

    return
  }

  if (type === 'session-open') {
    log(chalk.green(`Session opened (${message.sessionId || 'unknown'})`))
    return
  }

  if (type === 'session-close') {
    log(chalk.blue(`Session closed (${message.sessionId || 'unknown'})`))
    return
  }

  if (type === 'session-config') {
    log(chalk.blue('Session config received'))
    return
  }

  log(chalk.gray(`Ignoring message type: ${type}`))
}

// ── Token refresh on 1008 rejection ───────────────────────────────────────
// When the server rejects our token (code 1008), try to re-hire via the
// Chat Bridge CLI auth API to get a fresh connectionToken, update the WS
// URL, and reconnect — all without requiring the user to restart the CLI.

async function refreshTokenAndReconnect() {
  const { loadSession } = await import('./onboarding.js')
  const cached = loadSession()
  if (!cached?.sessionToken || !cached?.lastAgent?.handle || !cached?.lastOfficeId) {
    throw new Error('No cached session — cannot auto-refresh token')
  }

  const agentName = cached.lastAgent.handle.split('.')[0]
  const officeId = cached.lastOfficeId
  const chatBridgeBase = process.env.CHAT_BRIDGE_HTTP_URL ||
    process.env.CHAT_BRIDGE_URL ||
    process.env.CHAT_BRIDGE_BASE_URL ||
    'https://chatbridge.aladdinagi.xyz'

  const res = await fetch(`${chatBridgeBase}/api/cli/office/hire`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cli-session': cached.sessionToken,
    },
    body: JSON.stringify({ officeId, agentName, provider: 'claude-code' }),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`hire returned ${res.status}: ${text}`)
  }

  const data = await res.json()
  if (!data.connectionToken) {
    throw new Error('Server returned no connectionToken')
  }

  // Update WS URL with fresh token
  argv.token = data.connectionToken
  managerUrl.searchParams.set('token', data.connectionToken)

  // Persist fresh token to session cache
  const { saveSession } = await import('./onboarding.js')
  saveSession({
    ...cached,
    lastAgent: {
      ...cached.lastAgent,
      connectionToken: data.connectionToken,
      seat: data.seat || cached.lastAgent.seat,
    },
  })

  log(chalk.green('Token refreshed successfully, reconnecting...'))

  // Small delay to let Registry propagate the new token
  await new Promise(resolve => setTimeout(resolve, 1000))

  connect()
}

// ── WebSocket connection with reconnect ────────────────────────────────────

function connect() {
  log(chalk.blue(`Connecting to ${managerUrl.href}`))
  const ws = new WebSocket(managerUrl.href)
  wsRef = ws

  const PING_INTERVAL_MS = 10_000
  const PONG_TIMEOUT_MS = 8_000   // must be < PING_INTERVAL_MS
  let pingTimer = null
  let pongTimer = null
  let isAlive = false

  const stopHeartbeat = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
  }

  ws.on('open', async () => {
    log(chalk.green('Connected to Virtual Office'))
    reconnectAttempts = 0
    // Only reset tokenRetryAttempted after connection is stable for 10s
    // This prevents infinite 1008 reconnect loops where the server rejects
    // the fresh token immediately after ws.open fires
    const tokenResetTimer = setTimeout(() => { tokenRetryAttempted = false }, 10_000)
    ws.once('close', () => clearTimeout(tokenResetTimer))
    isAlive = true

    // Heartbeat: ping + pong timeout detection (matches cloud managerHostProxy pattern)
    pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { stopHeartbeat(); return }
      if (!isAlive) {
        log(chalk.red('Heartbeat timeout — no pong received, forcing reconnect'))
        stopHeartbeat()
        try { ws.terminate() } catch { /* ignore */ }
        return
      }
      isAlive = false
      try { ws.ping() } catch { /* ignore */ }
    }, PING_INTERVAL_MS)

    ws.on('pong', () => { isAlive = true })

    sendHostMeta(ws)

    // ── Flush buffered events from graceful disconnect ────────────────
    // Must happen AFTER sendHostMeta so the new Chat Bridge instance
    // recognises this host before receiving streaming events.
    if (gracefulDisconnect && pendingSendBuffer.length > 0) {
      log(chalk.green(`[shutdown] Reconnected — flushing ${pendingSendBuffer.length} buffered events`))
      for (const data of pendingSendBuffer) {
        try { ws.send(data) } catch { /* ignore */ }
      }
    }
    pendingSendBuffer.length = 0
    gracefulDisconnect = false
    if (gracefulKillTimer) {
      clearTimeout(gracefulKillTimer)
      gracefulKillTimer = null
    }

    // Registry heartbeat: report liveness independently of WS ping/pong.
    // This lets Chat Bridge know the agent process is alive even during
    // brief WS reconnection windows.
    startRegistryHeartbeat()

    // Build system prompt and register MCP server (first-class citizen setup)
    log(chalk.blue('Setting up agent identity and tools...'))
    if (!cachedSystemPrompt) {
      cachedSystemPrompt = await buildAgentSystemPrompt()
    }
    // Register MCP server via `claude mcp add` (the official way)
    // This makes VO tools auto-available in all `claude -p` invocations
    let mcpRegistered = false
    if (!mcpConfigPath) {
      mcpRegistered = await registerMcpServer()
      if (mcpRegistered) mcpConfigPath = 'registered'  // flag to skip re-registration
    }

    // Banner — show clock-in card once, reconnect banner on subsequent connects
    if (!hasShownClockInBanner) {
      hasShownClockInBanner = true
      const { printClockInBanner } = await import('./onboarding.js')
      printClockInBanner({
        agentHandle: argv.agent,
        model: 'Claude Opus 4.6',
        seat: onboardingSeat,
        workspace,
      })
    } else {
      const { printReconnectBanner } = await import('./onboarding.js')
      printReconnectBanner()
    }
  })

  ws.on('message', (data) => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch (err) {
      log(chalk.red(`Bad message: ${err.message}`))
      return
    }
    // Chat Bridge sends `server_shutdown` before closing during rolling deploys
    if (message.type === 'server_shutdown') {
      gracefulDisconnect = true
      log(chalk.yellow('[shutdown] Server announced graceful restart — keeping active sessions alive'))
      return
    }
    handleMessage(message)
  })

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || ''
    log(chalk.red(`Disconnected (${code} ${reasonStr})`))
    wsRef = null
    stopHeartbeat()
    // Keep registry heartbeat running during reconnection — it's independent
    // of the WS connection and tells Chat Bridge the process is still alive.

    // Reset system prompt so reconnect rebuilds it (prompt can change
    // between sessions). MCP server registration is persistent in Claude
    // Code's config, so don't reset mcpConfigPath — re-running execSync
    // on every reconnect blocks the event loop and kills the heartbeat.
    cachedSystemPrompt = null

    // ── Detect planned shutdown via close code (fallback) ──────────────
    // If the server_shutdown JSON message was lost due to race condition,
    // close code 1001 (Going Away) still indicates a planned shutdown
    // (ECS rolling deploy, etc.). Enter graceful mode to preserve children.
    if (!gracefulDisconnect && code === 1001) {
      gracefulDisconnect = true
      log(chalk.yellow('[shutdown] Server closed with 1001 (Going Away) — entering graceful mode'))
    }

    // ── Graceful disconnect: keep children alive, buffer output ───────
    if (gracefulDisconnect && code !== 1008) {
      log(chalk.yellow(`[shutdown] Graceful disconnect — keeping ${activeChildren.size} active children alive, buffering output`))
      // Safety timeout: if reconnect doesn't happen within 60s, give up
      gracefulKillTimer = setTimeout(() => {
        log(chalk.red('[shutdown] Reconnect timeout — killing buffered children'))
        for (const [, entry] of activeChildren) {
          try { entry?.child?.kill('SIGTERM') } catch { /* ignore */ }
        }
        activeChildren.clear()
        pendingSendBuffer.length = 0
        gracefulDisconnect = false
        gracefulKillTimer = null
      }, GRACEFUL_RECONNECT_TIMEOUT_MS)
      scheduleReconnect()
      return
    }

    // Non-graceful (crash/error): kill all active CLI processes
    for (const [, entry] of activeChildren) {
      try { entry?.child?.kill('SIGTERM') } catch { /* ignore */ }
    }
    activeChildren.clear()

    // Auth rejection — try to re-hire once to get a fresh token before giving up
    if (code === 1008) {
      if (!tokenRetryAttempted) {
        tokenRetryAttempted = true
        log(chalk.yellow('Token rejected, attempting automatic re-authentication...'))
        refreshTokenAndReconnect().catch((err) => {
          console.log('')
          console.log(chalk.red.bold('  Connection rejected: invalid or expired token.'))
          console.log(chalk.red(`  Re-auth failed: ${err.message}`))
          console.log(chalk.yellow('  Run "npx @office-xyz/claude-code" again to re-authenticate.'))
          console.log('')
          process.exit(1)
        })
        return
      }
      console.log('')
      console.log(chalk.red.bold('  Connection rejected: invalid or expired token (retry exhausted).'))
      console.log(chalk.yellow('  Run "npx @office-xyz/claude-code" again to re-authenticate.'))
      console.log('')
      process.exit(1)
    }

    scheduleReconnect()
  })

  ws.on('error', (err) => {
    log(chalk.red(`WebSocket error: ${err.message}`))
  })
}

function scheduleReconnect() {
  reconnectAttempts++
  // Faster reconnect during graceful shutdown (500ms base) vs crash (2s base)
  const baseDelay = gracefulDisconnect ? 500 : 2000
  const delay = Math.min(baseDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS)
  log(chalk.yellow(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})${gracefulDisconnect ? ' [graceful]' : ''}...`))
  setTimeout(connect, delay)
}

// ── Registry Heartbeat ────────────────────────────────────────────────────
// Reports agent liveness to Registry via Chat Bridge, independent of WS state.
// This ensures Chat Bridge knows the agent process is alive even during
// WS reconnection (up to 30s exponential backoff window).

function startRegistryHeartbeat() {
  if (registryHeartbeatTimer) return  // already running
  const agentHandle = argv.agent
  if (!agentHandle) return

  const chatBridgeHttpUrl =
    process.env.CHAT_BRIDGE_HTTP_URL ||
    process.env.CHAT_BRIDGE_URL ||
    process.env.CHAT_BRIDGE_BASE_URL ||
    'https://chatbridge.aladdinagi.xyz'

  const sendHeartbeat = async () => {
    try {
      const url = `${chatBridgeHttpUrl}/api/${encodeURIComponent(agentHandle)}/heartbeat`
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        log(chalk.dim(`[heartbeat] Registry heartbeat failed: ${resp.status} ${text}`))
      }
    } catch (err) {
      // Silent — heartbeat failures are non-critical
      log(chalk.dim(`[heartbeat] ${err.message}`))
    }
  }

  // Send immediately, then every 30s
  sendHeartbeat()
  registryHeartbeatTimer = setInterval(sendHeartbeat, REGISTRY_HEARTBEAT_INTERVAL_MS)
}

function stopRegistryHeartbeat() {
  if (registryHeartbeatTimer) {
    clearInterval(registryHeartbeatTimer)
    registryHeartbeatTimer = null
  }
}

// ── Local Device Connection (file system access for Workspace Panel) ───────
// Second WebSocket to Chat Bridge /local-agent — registers as a local device
// so the web UI can browse local files via Workspace Panel.
// Uses the same protocol as Adam Desktop (tool_request/tool_response).

let deviceWsRef = null

let deviceReconnectTimer = null
let devicePingTimer = null

function connectLocalDevice() {
  // Clear any pending reconnect to avoid duplicates
  if (deviceReconnectTimer) { clearTimeout(deviceReconnectTimer); deviceReconnectTimer = null }

  const chatBridgeWs = (process.env.CHAT_BRIDGE_WS_URL || 'wss://chatbridge.aladdinagi.xyz')
    .replace(/^http/, 'ws')
    .replace(/\/+$/, '')
  const deviceUrl = `${chatBridgeWs}/local-agent`

  log(chalk.blue(`Connecting local device to ${deviceUrl}`))
  const dws = new WebSocket(deviceUrl)
  deviceWsRef = dws

  const DEVICE_PING_INTERVAL_MS = 25_000
  const DEVICE_PONG_TIMEOUT_MS = 10_000
  let deviceIsAlive = false

  const stopDeviceHeartbeat = () => {
    if (devicePingTimer) { clearInterval(devicePingTimer); devicePingTimer = null }
  }

  dws.on('open', () => {
    log(chalk.green('Local device connected'))
    deviceIsAlive = true
    const agentHandle = argv.agent
    const officeId = agentHandle.split('.').slice(1).join('.')
    // Register as agent-bound device (NOT office-wide).
    // Only this specific agent's sessions can access the local file system.
    dws.send(JSON.stringify({
      type: 'register',
      officeId,
      agentHandle,
      userId: agentHandle,
      workingDirectory: workspace,
      metadata: {
        deviceType: 'local-agent',
        hostname: os.hostname(),
        platform: `${os.platform()}-${os.arch()}`,
        capabilities: ['file_ops', 'exec_command', 'computer_use'],
        agentBound: true,
        boundAgentHandle: agentHandle,
        officeWide: false,
      },
    }))

    // Heartbeat: ping + pong timeout detection
    stopDeviceHeartbeat()
    devicePingTimer = setInterval(() => {
      if (dws.readyState !== WebSocket.OPEN) { stopDeviceHeartbeat(); return }
      if (!deviceIsAlive) {
        log(chalk.red('[device] Heartbeat timeout — no pong received, forcing reconnect'))
        stopDeviceHeartbeat()
        try { dws.terminate() } catch { /* ignore */ }
        return
      }
      deviceIsAlive = false
      try { dws.ping() } catch { /* ignore */ }
    }, DEVICE_PING_INTERVAL_MS)

    dws.on('pong', () => { deviceIsAlive = true })
  })

  dws.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    // Ignore registration ack and other non-tool messages
    if (msg.type === 'tool_request') {
      const { requestId, toolName, params } = msg
      info(chalk.cyan(`[device] tool_request: ${toolName}`))
      try {
        const result = await executeLocalTool(toolName, params || {})
        dws.send(JSON.stringify({ type: 'tool_response', requestId, result }))
      } catch (err) {
        dws.send(JSON.stringify({ type: 'tool_response', requestId, error: err.message }))
      }
    }
  })

  dws.on('close', (code) => {
    log(chalk.yellow(`Local device disconnected (${code})`))
    deviceWsRef = null
    stopDeviceHeartbeat()
    // Reconnect after delay (only if not shutting down)
    if (code !== 1000) {
      deviceReconnectTimer = setTimeout(connectLocalDevice, 5000)
    }
  })

  dws.on('error', (err) => {
    log(chalk.dim(`[device] WebSocket error: ${err.message}`))
  })
}

/**
 * Execute a local tool request (file operations, shell commands).
 * Same capabilities as Adam Desktop's localTools.
 */
async function executeLocalTool(toolName, params) {
  const fs = await import('fs/promises')

  switch (toolName) {
    case 'list_files': {
      const dirPath = path.resolve(workspace, params.path || '.')
      const maxDepth = params.maxDepth || 1
      const IGNORED = new Set(['.git', 'node_modules', '__pycache__', '.next', '.venv', 'dist', '.cache'])

      async function buildTree(dir, depth) {
        let entries
        try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
        const nodes = []
        for (const entry of entries) {
          if (entry.name.startsWith('.') && IGNORED.has(entry.name)) continue
          if (IGNORED.has(entry.name)) continue
          const fullPath = path.join(dir, entry.name)
          const isDir = entry.isDirectory()
          const node = { name: entry.name, path: fullPath, type: isDir ? 'directory' : 'file' }
          try {
            const stat = await fs.stat(fullPath)
            node.size = stat.size
            node.modifiedAt = stat.mtime.toISOString()
          } catch { /* skip stat errors */ }
          if (isDir && depth < maxDepth) {
            node.children = await buildTree(fullPath, depth + 1)
          }
          nodes.push(node)
        }
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        return nodes
      }

      if (maxDepth > 1) {
        const children = await buildTree(dirPath, 1)
        return { files: children, tree: true }
      }
      // Original flat mode (backward compatible)
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const files = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name)
        try {
          const stat = await fs.stat(fullPath)
          return {
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          }
        } catch {
          return { name: entry.name, path: fullPath, type: entry.isDirectory() ? 'directory' : 'file' }
        }
      }))
      return { files }
    }

    case 'read_file': {
      const filePath = path.resolve(workspace, params.path)
      const content = await fs.readFile(filePath, 'utf-8')
      return { content, path: filePath }
    }

    case 'write_file': {
      const filePath = path.resolve(workspace, params.path)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, params.content || '', 'utf-8')
      return { success: true, path: filePath }
    }

    case 'delete_file': {
      const filePath = path.resolve(workspace, params.path)
      await fs.rm(filePath, { recursive: true, force: true })
      return { success: true, path: filePath }
    }

    case 'exec_command': {
      const { execSync } = await import('child_process')
      const result = execSync(params.command, {
        cwd: params.cwd || workspace,
        timeout: params.timeout || 30000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      })
      return { stdout: result, exitCode: 0 }
    }

    default:
      throw new Error(`Unknown local tool: ${toolName}`)
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown() {
  console.log('')
  console.log('  ' + chalk.yellow('⏻ ') + chalk.bold('Clocked out of Office.xyz'))
  console.log('')
  console.log(chalk.dim('  • Coordinate Local & Cloud Agents'))
  console.log(chalk.dim('  • Configure SaaS Work Environments'))
  console.log(chalk.dim('  • Create Bot Identities Across Channels'))
  console.log('')
  console.log(chalk.dim('  Visit ') + chalk.cyan.underline('https://office.xyz') + chalk.dim(' to manage your agents'))
  console.log('')
  // Stop registry heartbeat and unregister MCP server
  stopRegistryHeartbeat()
  unregisterMcpServer()
  for (const [, entry] of activeChildren) {
    try { entry?.child?.kill('SIGTERM') } catch { /* ignore */ }
  }
  activeChildren.clear()
  if (wsRef) {
    try { wsRef.close(1000, 'shutdown') } catch { /* ignore */ }
  }
  if (deviceWsRef) {
    try { deviceWsRef.close(1000, 'shutdown') } catch { /* ignore */ }
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Startup ────────────────────────────────────────────────────────────────

async function startup() {
  // Direct connect mode: --agent + --token provided → skip onboarding
  if (argv.agent && argv.token) {
    console.log('')
    console.log(chalk.bold('  Virtual Office — Local Host Adapter'))
    console.log(chalk.dim(`  Agent: ${argv.agent} | Provider: ${argv.provider}`))
    console.log('')

    // Check for provider API key (only for non-claude providers)
    if (providerConfig.envCheck && !process.env[providerConfig.envCheck]) {
      log(chalk.yellow(`Warning: ${providerConfig.envCheck} not set. ${argv.provider} may fail to start.`))
    }

    connect()
    connectLocalDevice()
    return
  }

  // Interactive onboarding mode: login → select office → name agent → clock in
  try {
    const { runOnboarding } = await import('./onboarding.js')
    const result = await runOnboarding()

    // Update runtime config with onboarding result
    argv.agent = result.agent
    argv.token = result.token
    hostId = result.agent
    label = result.agent.split('.')[0] || result.agent
    onboardingSeat = result.seat || null

    // Rebuild manager URL with new agent/token
    const newManagerUrl = new URL(argv.manager)
    newManagerUrl.searchParams.set('role', 'host')
    newManagerUrl.searchParams.set('hostId', hostId)
    newManagerUrl.searchParams.set('token', result.token)
    managerUrl.href = newManagerUrl.href

    // Banner will show once in connect() → ws.on('open') after fully ready
    connect()
    connectLocalDevice()
  } catch (err) {
    // If onboarding dependencies aren't installed (e.g., running from source without npm install)
    // fall back to showing help
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
      console.log('')
      console.log(chalk.bold('  Office.xyz — Claude Code'))
      console.log('')
      console.log(chalk.yellow('  Interactive mode requires additional dependencies.'))
      console.log(chalk.yellow('  Run: npm install   (in manager-host-sdk/local-host/)'))
      console.log('')
      console.log(chalk.dim('  Or use direct connect mode:'))
      console.log(chalk.dim('  npx @office-xyz/claude-code --agent <handle> --token <token>'))
      console.log('')
      process.exit(1)
    }
    console.error(chalk.red(`Startup error: ${err.message}`))
    process.exit(1)
  }
}

startup()