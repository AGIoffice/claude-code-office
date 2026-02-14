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

// ── Banner ────────────────────────────────────────────────────────────────

export function printBanner(subtitle = 'Manage Your AI Agents') {
  console.log('')
  console.log(chalk.cyan('  ┌─────────────────────────────────────────┐'))
  console.log(chalk.cyan('  │') + '                                         ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + chalk.bold.white('   ▓▓▓') + '                                   ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + chalk.bold.white('  ▓░░▓') + chalk.bold.white('   Virtual Office') + '                  ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + chalk.bold.white('  ▓▓▓▓') + chalk.dim(`   ${subtitle}`) + '           ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + chalk.bold.white('   ██') + '                                    ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + chalk.dim('  ▓▓▓▓   office.xyz') + '                      ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + '                                         ' + chalk.cyan('│'))
  console.log(chalk.cyan('  └─────────────────────────────────────────┘'))
  console.log('')
}

export function printClockInBanner({ agentHandle, model, seat, workspace }) {
  console.log('')
  console.log(chalk.cyan('  ┌─────────────────────────────────────────┐'))
  console.log(chalk.cyan('  │') + chalk.green.bold('  ✓ Clocked in to Virtual Office') + '         ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + '                                         ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + chalk.dim('  Agent:     ') + chalk.bold.white(agentHandle))
  console.log(chalk.cyan('  │') + chalk.dim('  Model:     ') + chalk.white(model || 'Claude Opus 4.6'))
  if (seat) {
    console.log(chalk.cyan('  │') + chalk.dim('  Seat:      ') + chalk.white(seat))
  }
  console.log(chalk.cyan('  │') + chalk.dim('  Workspace: ') + chalk.white(workspace || process.cwd()))
  console.log(chalk.cyan('  │') + '                                         ' + chalk.cyan('│'))
  console.log(chalk.cyan('  │') + chalk.yellow('  Press Ctrl+C to clock out') + '              ' + chalk.cyan('│'))
  console.log(chalk.cyan('  └─────────────────────────────────────────┘'))
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

// ── Agent Hire ────────────────────────────────────────────────────────────

async function hireAgent(officeId, sessionToken) {
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

  const spinner = ora('Setting up agent...').start()
  try {
    const result = await api('POST', '/api/cli/office/hire', {
      officeId,
      agentName: agentName.trim().toLowerCase(),
      provider: 'claude-code',
    }, sessionToken)

    spinner.succeed(`Agent ready: ${chalk.bold(result.agentHandle)}${result.seat ? chalk.dim(` (seat: ${result.seat})`) : ''}`)
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
  printBanner()

  // Check for updates (non-blocking, runs in background)
  checkForUpdate()

  // 1. Check cached session
  const cached = loadSession()

  if (cached?.sessionToken && cached?.lastAgent?.handle && cached?.lastAgent?.connectionToken) {
    // Quick reconnect path
    const spinner = ora('Validating session...').start()
    try {
      const validation = await api('GET', '/api/cli/auth/session', null, cached.sessionToken)
      if (validation.success) {
        spinner.succeed(`Welcome back, ${chalk.bold(cached.email || cached.displayName || 'user')}!`)
        console.log(chalk.dim(`  Reconnecting as ${cached.lastAgent.handle}...`))
        return {
          agent: cached.lastAgent.handle,
          token: cached.lastAgent.connectionToken,
          seat: cached.lastAgent.seat,
        }
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

  // 4. Name and hire agent
  const hired = await hireAgent(officeId, session.sessionToken)

  // 5. Save session
  saveSession({
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    sessionToken: session.sessionToken,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    lastOffice: domain,
    lastAgent: {
      handle: hired.agentHandle,
      connectionToken: hired.connectionToken,
      seat: hired.seat,
    },
  })

  return {
    agent: hired.agentHandle,
    token: hired.connectionToken,
    seat: hired.seat,
  }
}
