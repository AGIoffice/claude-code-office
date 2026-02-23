/**
 * CLI Onboarding Flow for @office-xyz/claude-code
 *
 * Interactive terminal experience:
 *   Login → Create/Join Office → Name Agent → Auto Seat → Clock In
 *
 * Session is cached in ~/.office-xyz/session.json so subsequent runs skip login.
 */

import chalk from 'chalk'
import { input, select, confirm } from '@inquirer/prompts'
import ora from 'ora'
import open from 'open'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import os from 'os'

const require = createRequire(import.meta.url)

// ── Config ────────────────────────────────────────────────────────────────

const SESSION_DIR = path.join(os.homedir(), '.office-xyz')
const SESSION_FILE = path.join(SESSION_DIR, 'session.json')

const CHAT_BRIDGE_URL =
  process.env.CHAT_BRIDGE_URL ||
  process.env.CHAT_BRIDGE_HTTP_URL ||
  'https://chatbridge.aladdinagi.xyz'

const PKG_NAME = '@office-xyz/claude-code'

// ── Pre-flight Check ──────────────────────────────────────────────────────

async function checkClaudeCodeCli() {
  const { execSync } = await import('child_process')

  // Check if claude is installed
  let version = null
  try {
    version = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    console.log(chalk.red('  Claude Code CLI is not installed.'))
    console.log('')
    console.log(chalk.white('  Install it:'))
    console.log(chalk.cyan('    curl -fsSL https://claude.ai/install.sh | bash'))
    console.log('')
    console.log(chalk.dim('  Or via npm: npm install -g @anthropic-ai/claude-code'))
    console.log('')
    process.exit(1)
  }

  console.log(chalk.dim(`  Detected: Claude Code ${version}`))

  // Check if logged in by running a quick command
  try {
    const result = execSync('claude -p "ping" --output-format text --max-turns 1', {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    })
    // If we get any response, auth works
    console.log(chalk.dim('  Auth: Claude login session ✓'))
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').toLowerCase()
    if (msg.includes('credit') || msg.includes('balance') || msg.includes('unauthorized') || msg.includes('auth')) {
      console.log(chalk.red('  Claude Code is not logged in.'))
      console.log('')
      console.log(chalk.white('  Run this first:'))
      console.log(chalk.cyan('    claude login'))
      console.log('')
      console.log(chalk.dim('  You need a Claude Pro, Max, or Team subscription.'))
      console.log('')
      process.exit(1)
    }
    // Other errors (timeout, etc.) — proceed anyway, might work
    console.log(chalk.dim('  Auth: could not verify (will try anyway)'))
  }
  console.log('')
}

// ── Update Check ──────────────────────────────────────────────────────────

/**
 * Non-blocking version check against npm registry.
 * Shows a one-line update notice if a newer version is available.
 * Never throws — silently skips on any error.
 */
export async function checkForUpdate() {
  try {
    const pkg = require('./package.json')
    const currentVersion = pkg.version
    if (!currentVersion) return

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000) // 3s max

    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) return
    const data = await res.json()
    const latestVersion = data.version

    if (!latestVersion || latestVersion === currentVersion) return

    // Simple semver compare: split into parts and compare numerically
    const current = currentVersion.split('.').map(Number)
    const latest = latestVersion.split('.').map(Number)
    let isNewer = false
    for (let i = 0; i < 3; i++) {
      if ((latest[i] || 0) > (current[i] || 0)) { isNewer = true; break }
      if ((latest[i] || 0) < (current[i] || 0)) break
    }

    if (isNewer) {
      console.log('')
      console.log(chalk.yellow(`  ⚠ Update available: ${currentVersion} → ${latestVersion}`))
      console.log(chalk.dim(`    Run: npm update -g ${PKG_NAME}`))
    }
  } catch {
    // Silent fail — network issues, registry down, etc.
  }
}

// ── Pixel House Art ──────────────────────────────────────────────────────
// Compact pixel-art office building used across all banners.

const HOUSE_COLOR = '#6B7280'
const BRAND_COLOR = '#5B7FFF'

const HOUSE_LINES = [
  '      ▄▄',
  '    ▄████▄',
  '  ▄████████▄',
  ' ██▀▀▀▀▀▀▀▀██',
  ' ██ ▪    ▪ ██',
  ' ██   ▄▄   ██',
  ' ██▄▄████▄▄██',
]

// Helper: print a row with house art on the left and info on the right.
const HOUSE_COL_W = 22
function _houseRow(house, info) {
  const visual = house.replace(/\x1b\[[0-9;]*m/g, '')
  const padded = house + ' '.repeat(Math.max(0, HOUSE_COL_W - visual.length))
  console.log('  ' + padded + (info || ''))
}

// ── Banner (startup, before clock-in) ────────────────────────────────────

export function printBanner({ email, agentHandle, model, workspace } = {}) {
  const h = chalk.hex(HOUSE_COLOR)
  const b = chalk.hex(BRAND_COLOR)
  const pkg = (() => { try { return require('./package.json') } catch { return {} } })()
  const version = pkg.version ? `v${pkg.version}` : ''
  const label = ` Office.xyz ${version} `
  const innerW = 72
  const leftColW = 28  // visual width for left column (house + info)
  const _strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')

  // Build left column
  const userName = email ? email.split('@')[0] : ''
  const welcome = userName ? `Welcome back, ${userName}!` : 'Welcome!'
  const leftLines = [
    '',
    chalk.bold(welcome.length > leftColW ? welcome.slice(0, leftColW - 1) + '…' : welcome),
    '',
    ...HOUSE_LINES.map(l => h(l)),
    '',
    model ? chalk.dim(model) : '',
    workspace ? chalk.dim(workspace) : '',
  ]
  // Build right column (max width = innerW - 1 - leftColW)
  const d = chalk.dim
  const rightLines = [
    '',
    chalk.bold('Manage Your AI Agents'),
    '',
    d('• Coordinate Local & Cloud Agents'),
    d('• Configure SaaS Work Environments'),
    d('• Create Bot Identities Across Channels'),
    '',
    agentHandle
      ? d(`Agent: ${agentHandle}`)
      : d(`Visit ${chalk.cyan.underline('https://office.xyz')}`),
  ]
  const maxRows = Math.max(leftLines.length, rightLines.length)

  console.log('')
  console.log('  ' + b(`╭${'──'}${label}${'─'.repeat(Math.max(0, innerW - 2 - label.length))}╮`))
  for (let i = 0; i < maxRows; i++) {
    const left = leftLines[i] || ''
    const right = rightLines[i] || ''
    const lw = _strip(left).length
    const rw = _strip(right).length
    const gap = ' '.repeat(Math.max(1, leftColW - lw))
    const tail = ' '.repeat(Math.max(0, innerW - 1 - leftColW - rw))
    console.log('  ' + b('│') + ' ' + left + gap + right + tail + b('│'))
  }
  console.log('  ' + b(`╰${'─'.repeat(innerW)}╯`))
  console.log('')
}

// ── Clock-in Banner (shown once after WS connected) ─────────────────────

export function printClockInBanner({ agentHandle, model, seat, workspace }) {
  const h = chalk.hex(HOUSE_COLOR)
  const b = chalk.hex(BRAND_COLOR)
  const d = chalk.dim
  const _strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
  const innerW = 72
  const leftColW = 20

  const leftLines = [
    '',
    ...HOUSE_LINES.map(l => h(l)),
  ]

  // Use non-breaking space for intentional blank lines ('' would be falsy)
  const _ = ' '
  const rightLines = [
    chalk.green.bold('✓ ') + chalk.bold('Clocked in to Office.xyz'),
    _,
    d('Agent  ') + chalk.white(agentHandle),
    d('Model  ') + chalk.white(model || 'Claude Opus 4.6'),
    ...(seat ? [d('Seat   ') + chalk.white(seat)] : []),
    d('Dir    ') + chalk.white(workspace || process.cwd()),
    _,
    d('• Coordinate Local & Cloud Agents'),
    d('• Configure SaaS Work Environments'),
    d('• Create Bot Identities Across Channels'),
    _,
    d('Press ') + chalk.yellow('Ctrl+C') + d(' to clock out'),
  ]

  const maxRows = Math.max(leftLines.length, rightLines.length)
  console.log('')
  console.log('  ' + b(`╭──${' Office.xyz '}${'─'.repeat(Math.max(0, innerW - 2 - 12))}╮`))
  for (let i = 0; i < maxRows; i++) {
    const left = leftLines[i] || ''
    const right = rightLines[i] || ''
    const lw = _strip(left).length
    const rw = _strip(right).length
    const gap = ' '.repeat(Math.max(1, leftColW - lw))
    const tail = ' '.repeat(Math.max(0, innerW - 1 - leftColW - rw))
    console.log('  ' + b('│') + ' ' + left + gap + right + tail + b('│'))
  }
  console.log('  ' + b(`╰${'─'.repeat(innerW)}╯`))
  console.log('')
}

// ── Reconnect Banner (minimal, one line) ─────────────────────────────────

export function printReconnectBanner() {
  console.log('')
  console.log('  ' + chalk.green('✓') + ' Reconnected to Office.xyz')
  console.log('')
}

// ── Session Storage ───────────────────────────────────────────────────────

export function loadSession() {
  try {
    if (!existsSync(SESSION_FILE)) return null
    const data = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    // Check expiry
    if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
      return null
    }
    return data
  } catch {
    return null
  }
}

export function saveSession(session) {
  try {
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true })
    }
    writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8')
  } catch (err) {
    console.warn(chalk.dim(`[session] Failed to save: ${err.message}`))
  }
}

export function clearSession() {
  try {
    if (existsSync(SESSION_FILE)) {
      writeFileSync(SESSION_FILE, '{}', 'utf-8')
    }
  } catch { /* ignore */ }
}

// ── API Helpers ───────────────────────────────────────────────────────────

async function api(method, path, body = null, sessionToken = null) {
  const url = `${CHAT_BRIDGE_URL}${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (sessionToken) headers['x-cli-session'] = sessionToken

  const options = { method, headers }
  if (body) options.body = JSON.stringify(body)

  const res = await fetch(url, options)
  const data = await res.json()

  if (!res.ok) {
    throw new Error(data.error || data.message || `API error ${res.status}`)
  }
  return data
}

// ── Browser Login Flow ────────────────────────────────────────────────────

async function browserLogin() {
  const spinner = ora('Starting login...').start()

  try {
    const { loginUrl, pollToken } = await api('POST', '/api/cli/auth/start')
    spinner.stop()

    console.log(chalk.dim('  Opening browser for login...'))
    await open(loginUrl)
    console.log(chalk.dim('  Waiting for authentication...'))
    console.log(chalk.dim(`  (If browser didn't open, visit: ${loginUrl})`))
    console.log('')

    const pollSpinner = ora('Waiting for login...').start()
    const POLL_INTERVAL = 1500
    const POLL_TIMEOUT = 5 * 60 * 1000

    const startTime = Date.now()
    while (Date.now() - startTime < POLL_TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      const result = await api('GET', `/api/cli/auth/poll?token=${pollToken}`)

      if (result.status === 'complete') {
        pollSpinner.succeed(chalk.green(`Logged in as ${result.session.email || result.session.userId}`))
        return { session: result.session, offices: result.offices || [] }
      }
      if (result.status === 'expired') {
        pollSpinner.fail('Login expired. Please try again.')
        process.exit(1)
      }
    }

    pollSpinner.fail('Login timed out. Please try again.')
    process.exit(1)
  } catch (err) {
    spinner.fail(`Login failed: ${err.message}`)
    process.exit(1)
  }
}

// ── Office Selection / Creation ───────────────────────────────────────────

async function selectOrCreateOffice(offices, sessionToken) {
  if (offices.length === 0) {
    // No offices — must create
    console.log(chalk.dim('  You don\'t have any offices yet. Let\'s create one!'))
    console.log('')
    return createOffice(sessionToken)
  }

  // Show offices with "Create new" option
  const choices = [
    ...offices.map(o => ({
      name: `${o.domain || o.slug || o.displayName}  ${chalk.dim(`${o.agentCount || 0} agents`)}`,
      value: o.id,
    })),
    {
      name: chalk.cyan('+ Create a new office'),
      value: '__create__',
    },
  ]

  const choice = await select({
    message: 'Select office:',
    choices,
  })

  if (choice === '__create__') {
    return createOffice(sessionToken)
  }

  const selected = offices.find(o => o.id === choice)
  return {
    officeId: selected.id,
    domain: selected.domain || selected.slug,
  }
}

async function createOffice(sessionToken) {
  const name = await input({
    message: 'Office name:',
    validate: (v) => v.trim().length > 0 || 'Name is required',
  })

  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  // Check availability
  const spinner = ora(`Checking ${slug}.office.xyz...`).start()
  try {
    const check = await api('GET', `/api/cli/office/slug-check?slug=${encodeURIComponent(slug)}`)
    if (!check.available) {
      spinner.warn(`${slug}.office.xyz is taken`)
      slug = await input({
        message: 'Choose a different slug:',
        validate: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v) || 'Lowercase alphanumeric + hyphens only',
      })
    } else {
      spinner.succeed(`${slug}.office.xyz is available`)
    }
  } catch {
    spinner.stop()
  }

  // Create
  const createSpinner = ora('Creating office...').start()
  try {
    const result = await api('POST', '/api/cli/office/create', { name, slug }, sessionToken)
    createSpinner.succeed(`Office created: ${chalk.bold(result.domain)}`)
    return { officeId: result.officeId, domain: result.domain }
  } catch (err) {
    createSpinner.fail(`Failed to create office: ${err.message}`)
    process.exit(1)
  }
}

// ── Role Selection ────────────────────────────────────────────────────────

const ROLE_CATEGORIES = [
  { id: 'business',  icon: '💼', label: 'Business',   description: 'Operations, Marketing, Sales, Support, Executive, HR' },
  { id: 'science',   icon: '🔬', label: 'Science',    description: 'Research, Data Science, Bioinformatics, Lab, Clinical' },
  { id: 'developer', icon: '💻', label: 'Developer',  description: 'Full-Stack, Frontend, Backend, DevOps, AI Engineering' },
  { id: 'education', icon: '📖', label: 'Education',  description: 'Learning, Tutoring, Knowledge Exploration' },
]

const ROLES = [
  // Business
  { id: 'operations',  category: 'business',  icon: '📈', label: 'Operations' },
  { id: 'marketing',   category: 'business',  icon: '📣', label: 'Marketing' },
  { id: 'sales',       category: 'business',  icon: '🤝', label: 'Sales' },
  { id: 'support',     category: 'business',  icon: '💬', label: 'Support' },
  { id: 'executive',   category: 'business',  icon: '👔', label: 'Executive' },
  { id: 'hr',          category: 'business',  icon: '👥', label: 'HR' },
  // Science
  { id: 'researcher',      category: 'science', icon: '🔬', label: 'Researcher' },
  { id: 'data-scientist',  category: 'science', icon: '📊', label: 'Data Scientist' },
  { id: 'bioinformatics',  category: 'science', icon: '🧬', label: 'Bioinformatics' },
  { id: 'lab-manager',     category: 'science', icon: '🧪', label: 'Lab Manager' },
  { id: 'clinical',        category: 'science', icon: '🏥', label: 'Clinical' },
  // Developer
  { id: 'fullstack', category: 'developer', icon: '🖥️', label: 'Full-Stack' },
  { id: 'frontend',  category: 'developer', icon: '🎨', label: 'Frontend' },
  { id: 'backend',   category: 'developer', icon: '⚙️',  label: 'Backend' },
  { id: 'devops',    category: 'developer', icon: '🔧', label: 'DevOps' },
  { id: 'ai-engineer', category: 'developer', icon: '🤖', label: 'AI Engineer' },
  // Education
  { id: 'learner', category: 'education', icon: '📖', label: 'Learner' },
]

async function selectRole() {
  const category = await select({
    message: 'What does your agent do?',
    choices: ROLE_CATEGORIES.map(c => ({
      name: `${c.icon} ${c.label}  ${chalk.dim(c.description)}`,
      value: c.id,
    })),
  })

  const rolesInCategory = ROLES.filter(r => r.category === category)

  const roleId = await select({
    message: 'Select a role:',
    choices: rolesInCategory.map(r => ({
      name: `${r.icon} ${r.label}`,
      value: r.id,
    })),
  })

  const role = ROLES.find(r => r.id === roleId)
  return { roleId, roleCategory: category, roleLabel: role?.label || roleId }
}

// ── Agent Selection / Hire ─────────────────────────────────────────────────

const PROVIDER_LABELS = {
  claude: 'Claude Code',
  anthropic: 'Claude',
  openai: 'Codex',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  volcengine: 'Volcengine',
  kimi: 'Kimi',
  ollama: 'Ollama',
}

async function selectOrHireAgent(officeId, sessionToken) {
  // 1. Check for existing agents in this office
  let existingAgents = []
  try {
    const data = await api('GET', `/api/cli/office/${encodeURIComponent(officeId)}/agents`, null, sessionToken)
    existingAgents = data.agents || []
  } catch {
    // Continue — will go straight to hire
  }

  // Only show local Claude agents — cloud agents and non-Claude agents can't be clocked in from this CLI
  const localAgents = existingAgents.filter(a =>
    a.deploymentMode === 'local' &&
    (a.provider === 'claude' || a.provider === 'claude-code' || a.provider === 'anthropic')
  )

  if (localAgents.length > 0) {
    // Show local agents + option to hire new
    const providerLabel = (p) => PROVIDER_LABELS[p] || p || 'unknown'

    const choices = [
      ...localAgents.map(a => ({
        name: `${a.name}  ${chalk.dim(`${a.role} · ${providerLabel(a.provider)} · ${a.seat || 'no seat'}`)}`,
        value: a.id,
      })),
      {
        name: chalk.cyan('+ Hire a new agent'),
        value: '__hire__',
      },
    ]

    const choice = await select({
      message: 'Select an agent to clock in:',
      choices,
    })

    if (choice !== '__hire__') {
      // Reconnect existing agent
      const agent = localAgents.find(a => a.id === choice)
      const spinner = ora('Reconnecting...').start()
      try {
        const result = await api('POST', '/api/cli/office/hire', {
          officeId,
          agentName: agent.name,
          provider: 'claude-code',
          roleId: agent.role,
          roleCategory: agent.roleCategory,
        }, sessionToken)

        spinner.succeed(`Reconnected: ${chalk.bold(result.agentHandle)} ${chalk.dim(`(${agent.role})`)}${result.seat ? chalk.dim(` · seat: ${result.seat}`) : ''}`)
        return result
      } catch (err) {
        spinner.fail(`Failed to reconnect: ${err.message}`)
        process.exit(1)
      }
    }
  }

  // 2. Hire new agent: select role
  const { roleId, roleCategory, roleLabel } = await selectRole()

  // 3. Name agent
  const agentName = await input({
    message: 'Name your Claude Code agent:',
    validate: (v) => {
      const name = v.trim().toLowerCase()
      if (!name) return 'Name is required'
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return 'Lowercase alphanumeric + hyphens only'
      return true
    },
    transformer: (v) => v.toLowerCase(),
  })

  // 4. Hire
  const spinner = ora('Setting up agent...').start()
  try {
    const result = await api('POST', '/api/cli/office/hire', {
      officeId,
      agentName: agentName.trim().toLowerCase(),
      provider: 'claude-code',
      roleId,
      roleCategory,
      roleLabel,
    }, sessionToken)

    spinner.succeed(`Agent ready: ${chalk.bold(result.agentHandle)} ${chalk.dim(`(${roleLabel})`)}${result.seat ? chalk.dim(` · seat: ${result.seat}`) : ''}`)
    return result
  } catch (err) {
    spinner.fail(`Failed to create agent: ${err.message}`)
    process.exit(1)
  }
}

// ── Main Onboarding Flow ─────────────────────────────────────────────────

/**
 * Run the interactive onboarding flow.
 * Returns { agent, token } to pass to the connection logic.
 *
 * @returns {{ agent: string, token: string, seat?: string }}
 */
export async function runOnboarding() {
  // 1. Check cached session (local file, instant)
  const cached = loadSession()

  // Show banner with cached user info if available
  printBanner(cached?.sessionToken && cached?.lastAgent?.handle ? {
    email: cached.email || cached.displayName,
    agentHandle: cached.lastAgent.handle,
    model: 'Claude Opus 4.6',
    workspace: process.cwd(),
  } : {})

  // Check for updates (non-blocking, runs in background)
  checkForUpdate()

  // 0. Pre-flight: check Claude Code CLI is installed and logged in
  await checkClaudeCodeCli()

  if (cached?.sessionToken && cached?.lastAgent?.handle) {
    // Quick reconnect path — always refresh token to avoid stale token rejection
    const spinner = ora('Validating session...').start()
    try {
      const validation = await api('GET', '/api/cli/auth/session', null, cached.sessionToken)
      if (validation.success) {
        spinner.text = 'Refreshing connection...'

        // Re-hire with same agent name to get a fresh connectionToken.
        // This is idempotent — if agent exists, it just refreshes the token.
        const agentName = cached.lastAgent.handle.split('.')[0]
        const officeId = cached.lastOfficeId || null

        let freshToken = null
        let seat = cached.lastAgent.seat

        if (agentName && officeId) {
          try {
            const result = await api('POST', '/api/cli/office/hire', {
              officeId,
              agentName,
              provider: 'claude-code',
              roleId: cached.lastAgent.roleId,
              roleCategory: cached.lastAgent.roleCategory,
              roleLabel: cached.lastAgent.roleLabel,
            }, cached.sessionToken)

            if (!result.connectionToken) {
              throw new Error('Server returned no connectionToken')
            }
            freshToken = result.connectionToken
            seat = result.seat || seat

            // Update cached session with fresh token
            saveSession({
              ...cached,
              lastAgent: {
                ...cached.lastAgent,
                connectionToken: freshToken,
                seat,
              },
            })
          } catch (err) {
            // Token refresh failed — fall through to full browser login.
            // Using a stale cached token would cause 1008 rejection because
            // a successful /hire already rotated the token in the Registry.
            console.log(chalk.dim(`  Token refresh failed (${err.message}), re-authenticating...`))
            spinner.stop()
            // Fall through to browser login below
          }
        }

        if (freshToken) {
          // Wait for Registry propagation before connecting — without this,
          // Chat Bridge may still see the old token and reject with 1008.
          await new Promise(resolve => setTimeout(resolve, 1000))
          spinner.succeed(`Reconnecting as ${chalk.bold(cached.lastAgent.handle)}...`)
          return {
            agent: cached.lastAgent.handle,
            token: freshToken,
            seat,
          }
        }
        // freshToken is null — fall through to browser login
      }
    } catch {
      // Session expired — fall through to login
    }
    spinner.stop()
  }

  // 2. Browser login
  const { session, offices } = await browserLogin()

  // 3. Select or create office
  const { officeId, domain } = await selectOrCreateOffice(offices, session.sessionToken)

  // 4. Select existing agent or hire new
  const hired = await selectOrHireAgent(officeId, session.sessionToken)

  // 5. Save session
  saveSession({
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    sessionToken: session.sessionToken,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    lastOffice: domain,
    lastOfficeId: officeId,
    lastAgent: {
      handle: hired.agentHandle,
      connectionToken: hired.connectionToken,
      seat: hired.seat,
      roleId: hired.roleId,
      roleCategory: hired.roleCategory,
      roleLabel: hired.roleLabel,
    },
  })

  if (!hired.connectionToken) {
    console.log(chalk.red('  Server did not return a connection token. Please try again.'))
    process.exit(1)
  }

  return {
    agent: hired.agentHandle,
    token: hired.connectionToken,
    seat: hired.seat,
  }
}
