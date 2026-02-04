#!/usr/bin/env node

// Touch the hot-reload gate file used by bot.js (default: ./open_fire).
// This is the scriptable equivalent of `touch open_fire`.
//
// Usage:
//   node scripts/reload-gate.js
//   HOT_RELOAD_GATE=somefile node scripts/reload-gate.js
//   node scripts/reload-gate.js --gate somefile
//   HOT_RELOAD_GATE=off node scripts/reload-gate.js

const fs = require('fs')
const path = require('path')

function parseArgv () {
  const out = { args: {} }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    const t = a[i]
    if (!t.startsWith('--')) continue
    const k = t.replace(/^--/, '').toLowerCase()
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true
    out.args[k] = v
  }
  return out
}

function resolveGatePath () {
  const argv = parseArgv()
  const arg = argv.args.gate
  const env = process.env.HOT_RELOAD_GATE
  let v = (arg != null) ? String(arg) : (env != null ? String(env) : 'open_fire')
  const s = String(v).toLowerCase()
  if (s === '0' || s === 'off' || s === 'false' || s === 'no' || s === 'disable' || s === 'disabled') return null
  if (s === '' || s === '1' || s === 'on' || s === 'true' || s === 'yes') v = 'open_fire'
  return path.resolve(process.cwd(), v)
}

function touch (p) {
  const now = new Date()
  const fd = fs.openSync(p, 'a')
  try { fs.closeSync(fd) } catch {}
  try { fs.utimesSync(p, now, now) } catch {}
}

function main () {
  const gatePath = resolveGatePath()
  if (!gatePath) {
    process.stderr.write('hot reload gate is disabled (HOT_RELOAD_GATE=off)\n')
    process.exit(1)
  }
  touch(gatePath)
  process.stdout.write(`touched ${gatePath}\n`)
}

main()

