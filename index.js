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
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { writeFileSync, readFileSync, mkdtempSync } from 'fs'
import { execSync } from 'child_process'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { normalizeToolName } from '../prompt/toolNameNormalizer.js'

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
function log(...args) {
  console.log(chalk.dim(`[${new Date().toISOString()}][${label}]`), ...args)
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
const MAX_RECONNECT_DELAY_MS = 30_000
const workspace = path.resolve(argv.workspace)
const model = argv.model || providerConfig.defaultModel

// ── Session tracking ───────────────────────────────────────────────────────
// Map VO sessionId → Claude session_id for conversation continuity.
// Cleared on clock-in to avoid stale sessions that ignore --append-system-prompt.
const SESSION_MAP_FILE = path.join(os.tmpdir(), `vo-sessions-${(argv.agent || 'pending').replace(/\./g, '-')}.json`)
const sessionMap = new Map()

// Clear stale sessions on startup — stale sessions from previous clock-ins
// ignore new --append-system-prompt and MCP tools.
try {
  require('fs').unlinkSync(SESSION_MAP_FILE)
  // Will be re-created when first session is mapped
} catch { /* no file to delete */ }

// Track active command processes PER SESSION for concurrent conversation support.
// Key: sessionId, Value: { child, commandId }. Different clients (web, Telegram)
// use different sessionIds and can run in parallel without killing each other.
const activeChildren = new Map()

// ── System Prompt & MCP (First-Class Citizen) ──────────────────────────────
// Built on connect, cached for the lifetime of the connection.
let cachedSystemPrompt = null
let mcpConfigPath = null

/**
 * Build the system prompt from Registry metadata (same as cloud host adapters).
 * This gives the local agent its identity, office context, and tool manuals.
 */
async function buildAgentSystemPrompt() {
  try {
    // Dynamic import — the prompt module is ESM
    const { buildSystemPrompt } = await import('../prompt/index.mjs')
    const agentHandle = argv.agent
    const officeId = agentHandle.split('.').slice(1).join('.')

    const prompt = await buildSystemPrompt({
      agentHandle,
      officeId,
      workspaceRoot: workspace,
      platform: `${os.platform()}-${os.arch()}`,
    })

    if (prompt && prompt.length > 100) {
      log(chalk.green(`System prompt built (${prompt.length} chars)`))
      return prompt
    }
    log(chalk.yellow('System prompt too short or empty, using default'))
    return null
  } catch (err) {
    log(chalk.yellow(`Failed to build system prompt: ${err.message}`))
    return null
  }
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
    const mcpServerPath = path.resolve(__dirname, '../mcp-server/skyoffice-mcp-server.js')

    const chatBridgeUrl = process.env.CHAT_BRIDGE_URL ||
      process.env.CHAT_BRIDGE_BASE_URL ||
      'https://chatbridge.aladdinagi.xyz'

    // Use agent-specific MCP name to avoid conflicts when multiple agents run
    const mcpName = `vo-${agentHandle.split('.')[0]}`

    // Remove existing (idempotent)
    try {
      execSync(`claude mcp remove ${mcpName}`, { stdio: 'ignore', timeout: 5000 })
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

    execSync(`claude mcp add-json ${mcpName} '${serverConfig.replace(/'/g, "'\\''")}' --scope user`, {
      stdio: 'pipe',
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

// ── Message handling ───────────────────────────────────────────────────────

function sendJSON(payload) {
  if (wsRef && wsRef.readyState === WebSocket.OPEN) {
    wsRef.send(JSON.stringify(payload))
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
    const text = message.command || message.content || ''
    if (!text) return

    const sessionId = message.sessionId || null
    const commandId = message.commandId || message.messageId || `cmd-${Date.now()}`

    const sessionLabel = sessionId ? sessionId.split('--')[1]?.slice(0, 15) || sessionId.slice(0, 20) : 'default'
    log(chalk.cyan(`→ [${sessionLabel}] ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`))

    // Kill previous command for THIS SESSION only. Other sessions continue in parallel.
    const prev = sessionId ? activeChildren.get(sessionId) : null
    if (prev?.child) {
      log(chalk.dim(`[${sessionLabel}] Killing previous command for same session`))
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
    if (claudeSessionId && providerConfig.resumeFlag) {
      args.push(providerConfig.resumeFlag, claudeSessionId)
    }
    // System prompt + platform context injection.
    // shell: false — no escaping needed, args passed directly.
    let systemPromptTmpFile = null
    const platformInfo = message.platformInfo || null
    let promptToInject = cachedSystemPrompt || ''
    
    // Append platform context so agent knows the message source (Telegram/Slack/Web)
    if (platformInfo?.clientType) {
      const clientLabel = platformInfo.clientType.replace(/-/g, ' ')
      promptToInject += `\n\n## Current Platform\nYou are responding via ${clientLabel}.`
      if (platformInfo.chatId) promptToInject += ` Chat ID: ${platformInfo.chatId}.`
      if (platformInfo.platformContext) promptToInject += `\n${platformInfo.platformContext}`
      log(chalk.dim(`[platform] ${platformInfo.clientType}${platformInfo.chatId ? ` (chat: ${platformInfo.chatId})` : ''}`))
    }
    
    if (promptToInject) {
      args.push('--append-system-prompt', promptToInject)
    }
    // MCP: no --mcp-config flag needed. The VO MCP server is registered via
    // `claude mcp add` during clock-in, so `claude -p` auto-loads it.
    // See: https://code.claude.com/docs/en/mcp
    // User message as last positional argument (raw, no escaping needed with shell: false)
    args.push(text)

    log(chalk.blue(`Running: ${cmd} ${args.slice(0, 5).join(' ')}... [${args.length} args]`))
    if (process.env.ANTHROPIC_API_KEY) {
      log(chalk.dim(`  Auth: Claude login session (stripped inherited API key from env)`))
    } else {
      log(chalk.dim(`  Auth: Claude login session`))
    }

    // 1. Send streaming.started
    sendJSON({
      type: 'streaming.started',
      sessionId,
      commandId,
      status: 'running',
      startedAt: new Date().toISOString(),
    })

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
    const activeToolsByIndex = new Map()
    const activeToolsById = new Map()
    const finalizedToolIds = new Set()
    const completedToolActions = []
    const activeThinkingByIndex = new Map()
    const completedThinkingBlocks = []

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

    rl.on('line', (line) => {
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

        // Thinking deltas
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
          sendJSON({
            type: 'thinking_event',
            sessionId,
            commandId,
            event: {
              eventType: 'thinking_delta',
              thinkingId,
              text: deltaText,
              timestamp: now,
            },
          })
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

          if (block?.type === 'tool_use') {
            const toolUseId = block.id || `tool-${now}-${Math.random().toString(36).slice(2, 8)}`
            if (blockIndex !== null) {
              activeToolsByIndex.set(blockIndex, {
                toolUseId,
                toolName: block.name || 'tool',
                input: block.input,
              })
            }
            emitToolStart({
              toolUseId,
              toolName: block.name || 'tool',
              input: block.input,
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
          if (event.result && !fullText) {
            fullText = event.result
          }
          return
        }

        // Message event with assistant content
        if (event.type === 'message' && event.message?.role === 'assistant') {
          const content = event.message.content || []
          for (const block of content) {
            // Extract text blocks
            if (block.type === 'text' && block.text) {
              if (!fullText) fullText = block.text
            }
            // Extract complete tool_use input — the assistant message contains the
            // fully accumulated input (unlike content_block_start which has {}).
            // This allows us to retroactively update tool events with real input data.
            if (block.type === 'tool_use' && block.id && block.input) {
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
      } catch {
        // Not JSON or unrecognized format — ignore
      }
    })

    // stderr → log
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      if (text.trim()) {
        log(chalk.dim(`[stderr] ${text.trim().slice(0, 200)}`))
      }
    })

    // 4. On process exit, send completion events
    child.on('close', (code) => {
      if (sessionId && activeChildren.get(sessionId)?.child === child) activeChildren.delete(sessionId)

      // Clean up system prompt temp file
      if (systemPromptTmpFile) {
        try { require('fs').unlinkSync(systemPromptTmpFile) } catch { /* ignore */ }
      }

      // Store Claude session_id for conversation continuity
      if (resultSessionId && sessionId) {
        sessionMap.set(sessionId, resultSessionId)
        log(chalk.dim(`Session mapped: ${sessionId} → ${resultSessionId}`))
      }

      if (fullText) {
        process.stdout.write('\n')
        log(chalk.green(`← ${fullText.slice(0, 80)}${fullText.length > 80 ? '...' : ''}`))
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
    })

    child.on('error', (err) => {
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
    })

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

    // Banner
    console.log('')
    console.log(chalk.bold.cyan('  ╔══════════════════════════════════════╗'))
    console.log(chalk.bold.cyan('  ║  Clocked in to Virtual Office       ║'))
    console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝'))
    console.log(chalk.dim(`  Agent:    ${argv.agent}`))
    console.log(chalk.dim(`  Provider: ${argv.provider}`))
    console.log(chalk.dim(`  Workspace: ${workspace}`))
    console.log(chalk.dim(`  Identity: ${cachedSystemPrompt ? 'loaded' : 'default'}`))
    console.log(chalk.dim(`  Tools:    ${mcpRegistered ? 'VO MCP registered ✓' : 'basic only'}`))
    console.log(chalk.dim(`  Press Ctrl+C to clock out`))
    console.log('')
  })

  ws.on('message', (data) => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch (err) {
      log(chalk.red(`Bad message: ${err.message}`))
      return
    }
    handleMessage(message)
  })

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || ''
    log(chalk.red(`Disconnected (${code} ${reasonStr})`))
    wsRef = null
    stopHeartbeat()

    // Kill all active CLI processes on disconnect
    for (const [, entry] of activeChildren) {
      try { entry?.child?.kill('SIGTERM') } catch { /* ignore */ }
    }
    activeChildren.clear()

    // Auth rejection — don't retry, token is invalid or missing
    if (code === 1008) {
      console.log('')
      console.log(chalk.red.bold('  Connection rejected: invalid or expired token.'))
      console.log(chalk.yellow('  Please re-invite the agent from the Virtual Office UI'))
      console.log(chalk.yellow('  to generate a fresh --token.'))
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
  const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS)
  log(chalk.yellow(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})...`))
  setTimeout(connect, delay)
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
      log(chalk.cyan(`[device] tool_request: ${toolName}`))
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
  log(chalk.yellow('Clocking out...'))
  // Unregister MCP server so it doesn't linger in ~/.claude.json
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
    const { runOnboarding, printClockInBanner } = await import('./onboarding.js')
    const result = await runOnboarding()

    // Update runtime config with onboarding result
    argv.agent = result.agent
    argv.token = result.token
    hostId = result.agent
    label = result.agent.split('.')[0] || result.agent

    // Rebuild manager URL with new agent/token
    const newManagerUrl = new URL(argv.manager)
    newManagerUrl.searchParams.set('role', 'host')
    newManagerUrl.searchParams.set('hostId', hostId)
    newManagerUrl.searchParams.set('token', result.token)
    managerUrl.href = newManagerUrl.href

    printClockInBanner({
      agentHandle: result.agent,
      model: `Claude Opus 4.6`,
      seat: result.seat,
      workspace: workspace,
    })

    connect()
    connectLocalDevice()
  } catch (err) {
    // If onboarding dependencies aren't installed (e.g., running from source without npm install)
    // fall back to showing help
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
      console.log('')
      console.log(chalk.bold('  Virtual Office — Claude Code'))
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