#!/usr/bin/env node

// Best-effort bot restart helper for local workflows.
// - Sends SIGINT to PID found in ./.mcbot.pid (written by bot.js)
// - Waits for exit
// - Starts a new `node bot.js` in the foreground (stdio inherit)
//
// Usage:
//   node scripts/restart-bot.js
//   node scripts/restart-bot.js --wait-ms 8000
//   node scripts/restart-bot.js -- --host ... --port ...

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

function parseArgv () {
  const out = { args: {}, rest: [] }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    const t = a[i]
    if (t === '--') { out.rest = a.slice(i + 1); break }
    if (!t.startsWith('--')) continue
    const k = t.replace(/^--/, '').toLowerCase()
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true
    out.args[k] = v
  }
  return out
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main () {
  const argv = parseArgv()
  const waitMs = Math.max(500, parseInt(String(argv.args['wait-ms'] || '5000'), 10))
  const pidPath = path.resolve(process.cwd(), '.mcbot.pid')

  let pid = null
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim()
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 1) pid = n
  } catch {}

  if (pid && pidAlive(pid)) {
    process.stdout.write(`sending SIGINT to pid=${pid}\n`)
    try { process.kill(pid, 'SIGINT') } catch {}
    const until = Date.now() + waitMs
    while (Date.now() < until) {
      if (!pidAlive(pid)) break
      await sleep(120)
    }
    if (pidAlive(pid)) {
      process.stderr.write(`pid=${pid} still alive after ${waitMs}ms; aborting restart\n`)
      process.exit(1)
    }
    process.stdout.write('stopped\n')
  } else {
    process.stdout.write('no running pid found; starting bot\n')
  }

  const child = spawn(process.execPath, [path.resolve(process.cwd(), 'bot.js'), ...argv.rest], {
    stdio: 'inherit',
    env: process.env
  })
  child.on('exit', (code) => process.exit(code == null ? 1 : code))
}

main().catch((err) => {
  process.stderr.write(String(err?.message || err) + '\n')
  process.exit(1)
})

