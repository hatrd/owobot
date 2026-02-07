#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

function parseArgv () {
  const out = { flags: {}, botArgs: [] }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--') {
      out.botArgs.push(...args.slice(i + 1))
      break
    }
    if (!token.startsWith('--')) {
      out.botArgs.push(token)
      continue
    }
    const normalized = token.slice(2)
    const eq = normalized.indexOf('=')
    if (eq >= 0) {
      const key = normalized.slice(0, eq)
      const value = normalized.slice(eq + 1)
      out.flags[key] = value
      continue
    }
    const key = normalized
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      out.flags[key] = next
      i++
    } else {
      out.flags[key] = true
    }
  }
  return out
}

function parseBool (value, fallback = false) {
  if (value == null) return fallback
  const text = String(value).trim().toLowerCase()
  if (!text) return fallback
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

function parseDurationMs (raw, fallback) {
  if (raw == null) return fallback
  const text = String(raw).trim()
  if (!text) return fallback
  const match = text.match(/^(-?\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (!match) return fallback
  const n = Number(match[1])
  if (!Number.isFinite(n) || n < 0) return fallback
  const unit = String(match[2] || 'ms').toLowerCase()
  if (unit === 'ms') return Math.round(n)
  if (unit === 's') return Math.round(n * 1000)
  if (unit === 'm') return Math.round(n * 60 * 1000)
  if (unit === 'h') return Math.round(n * 60 * 60 * 1000)
  return fallback
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Math.floor(ms))))
}

function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid (pidPath) {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim()
    const pid = parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

function readCmdline (pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`)
    return raw.toString('utf8').replace(/\u0000/g, ' ').trim()
  } catch {
    return ''
  }
}

function isLikelyBotProcess (pid) {
  const cmdline = readCmdline(pid)
  if (!cmdline) return true
  return cmdline.includes('bot.js')
}

async function waitForPidExit (pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() <= deadline) {
    if (!pidAlive(pid)) return true
    await sleep(120)
  }
  return !pidAlive(pid)
}

async function ensureNoExistingBot ({ pidPath, takeover, takeoverWaitMs }) {
  const pid = readPid(pidPath)
  if (!pid || !pidAlive(pid)) return
  if (!isLikelyBotProcess(pid)) {
    throw new Error(`pid file points to non-bot process: pid=${pid}`)
  }
  if (!takeover) {
    throw new Error(`existing bot process detected: pid=${pid}. Use --takeover to stop it first.`)
  }
  process.stdout.write(`[watch] stopping existing bot pid=${pid}\n`)
  try { process.kill(pid, 'SIGINT') } catch {}
  const stopped = await waitForPidExit(pid, takeoverWaitMs)
  if (!stopped) {
    throw new Error(`existing bot pid=${pid} did not exit within ${takeoverWaitMs}ms`)
  }
  process.stdout.write(`[watch] existing bot pid=${pid} stopped\n`)
}

async function waitChildExit (child) {
  return await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function main () {
  const argv = parseArgv()
  if (argv.flags.help || argv.flags.h) {
    process.stdout.write([
      'usage: node scripts/bot-watch.js [flags] [-- bot.js args...]',
      'flags:',
      '  --takeover [true|false]   stop existing pid from .mcbot.pid before start (default: false)',
      '  --takeover-wait-ms <dur>  wait for takeover stop (default: 8000ms)',
      '  --min-restart-ms <dur>    minimum restart delay (default: 1000ms)',
      '  --max-restart-ms <dur>    maximum restart delay (default: 30000ms)',
      '  --stable-ms <dur>         uptime threshold to reset backoff (default: 20000ms)',
      '  --stop-timeout-ms <dur>   force-kill timeout after SIGINT/SIGTERM (default: 6000ms)',
      '  --once [true|false]       run one bot process only (default: false)'
    ].join('\n') + '\n')
    return
  }

  const cwd = process.cwd()
  const botEntry = path.resolve(cwd, 'bot.js')
  const pidPath = path.resolve(cwd, '.mcbot.pid')
  const takeover = parseBool(argv.flags.takeover, false)
  const once = parseBool(argv.flags.once, false)
  const takeoverWaitMs = Math.max(500, parseDurationMs(argv.flags['takeover-wait-ms'], 8000))
  const minRestartMs = Math.max(200, parseDurationMs(argv.flags['min-restart-ms'], 1000))
  const maxRestartMs = Math.max(minRestartMs, parseDurationMs(argv.flags['max-restart-ms'], 30000))
  const stableMs = Math.max(1000, parseDurationMs(argv.flags['stable-ms'], 20000))
  const stopTimeoutMs = Math.max(500, parseDurationMs(argv.flags['stop-timeout-ms'], 6000))

  if (!fs.existsSync(botEntry)) {
    throw new Error(`bot entry not found: ${botEntry}`)
  }

  await ensureNoExistingBot({ pidPath, takeover, takeoverWaitMs })

  let child = null
  let stopping = false
  let backoffExp = 0

  const stopWatcher = (signal) => {
    if (stopping) return
    stopping = true
    process.stdout.write(`[watch] received ${signal}, stopping...\n`)
    if (child && child.exitCode == null) {
      try { process.kill(child.pid, signal) } catch {}
      setTimeout(() => {
        if (!child || child.exitCode != null) return
        process.stdout.write(`[watch] child pid=${child.pid} still alive, sending SIGKILL\n`)
        try { process.kill(child.pid, 'SIGKILL') } catch {}
      }, stopTimeoutMs)
    }
  }

  process.on('SIGINT', () => stopWatcher('SIGINT'))
  process.on('SIGTERM', () => stopWatcher('SIGTERM'))

  while (!stopping) {
    const env = {
      ...process.env,
      MCBOT_WATCHER: '1',
      MCBOT_WATCHER_PID: String(process.pid)
    }
    child = spawn(process.execPath, [botEntry, ...argv.botArgs], {
      cwd,
      env,
      stdio: 'inherit'
    })

    const pid = child.pid
    process.stdout.write(`[watch] started bot pid=${pid}\n`)
    const startedAt = Date.now()
    const { code, signal } = await waitChildExit(child)
    const uptimeMs = Date.now() - startedAt

    if (stopping) break
    if (once) {
      process.exit(Number.isFinite(code) ? code : 0)
      return
    }

    if (uptimeMs >= stableMs) backoffExp = 0
    else backoffExp = Math.min(backoffExp + 1, 10)

    const delayMs = Math.min(maxRestartMs, Math.round(minRestartMs * Math.pow(2, backoffExp)))
    process.stdout.write(`[watch] bot exited pid=${pid} code=${code == null ? 'null' : code} signal=${signal || 'null'} uptime=${uptimeMs}ms, restarting in ${delayMs}ms\n`)
    await sleep(delayMs)
  }

  process.stdout.write('[watch] stopped\n')
}

main().catch((err) => {
  process.stderr.write(`[watch] fatal: ${String(err?.message || err)}\n`)
  process.exit(1)
})

