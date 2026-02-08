#!/usr/bin/env node

// Minimal control client for bot.js Unix socket control plane (.mcbot.sock).
// Usage:
//   node scripts/botctl.js hello
//   node scripts/botctl.js list
//   node scripts/botctl.js dry <tool> [key=value ...]
//   node scripts/botctl.js run <tool> [key=value ...]
//   node scripts/botctl.js observe snapshot [key=value ...]
//   node scripts/botctl.js observe prompt [key=value ...]
//   node scripts/botctl.js observe detail [key=value ...]
//   node scripts/botctl.js chatdry username=kuleizi content="附近小狗小猫有什么" [withTools=true] [maxToolCalls=6]
//   node scripts/botctl.js schema ctl|observe|tool
//   node scripts/botctl.js restart [mode=detached|inherit] [delayMs=200ms]
// Options:
//   --sock <path>   override socket path (default: $PWD/.mcbot.sock)
//   --token <token> optional shared secret (or env MCBOT_CTL_TOKEN)

const net = require('net')
const path = require('path')
const controlPlaneContract = require('../bot_impl/control-plane-contract')

function parseArgv () {
  const out = { flags: {}, rest: [] }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    const t = a[i]
    if (!t.startsWith('--')) { out.rest.push(t); continue }
    const k = t.replace(/^--/, '')
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true
    out.flags[k] = v
  }
  return out
}

function parseKeyValueArgs (tokens) {
  const args = {}
  for (const raw of tokens) {
    const s = String(raw || '').trim()
    if (!s) continue
    const idx = s.indexOf('=')
    if (idx <= 0) continue
    const k = s.slice(0, idx).trim()
    const v = s.slice(idx + 1)
    if (!k) continue
    args[k] = v
  }
  // Light coercion for common numeric fields.
  for (const k of Object.keys(args)) {
    const v = args[k]
    if (typeof v !== 'string') continue
    if (!/^-?\d+(\.\d+)?$/.test(v.trim())) continue
    const n = Number(v)
    if (Number.isFinite(n)) args[k] = n
  }
  return args
}

function makeId () {
  return `ctl_${Date.now()}_${Math.floor(Math.random() * 100000)}`
}

function schemaTargetsUsage () {
  return controlPlaneContract.listCtlSchemaTargets().join('|')
}

function observeModesUsage () {
  return controlPlaneContract.listObserveModes().join('|')
}

function request (sockPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: sockPath })
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('error', reject)
    socket.on('connect', () => {
      try { socket.write(JSON.stringify(payload) + '\n') } catch (e) { reject(e) }
    })
    socket.on('data', (chunk) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) return
      let res
      try { res = JSON.parse(line) } catch (e) { reject(e); try { socket.end() } catch {}; return }
      try { socket.end() } catch {}
      resolve(res)
    })
  })
}

async function main () {
  const argv = parseArgv()
  const sockPath = argv.flags.sock ? path.resolve(String(argv.flags.sock)) : path.resolve(process.cwd(), '.mcbot.sock')
  const token = argv.flags.token != null ? String(argv.flags.token) : (process.env.MCBOT_CTL_TOKEN != null ? String(process.env.MCBOT_CTL_TOKEN) : '')
  const [cmd, ...rest] = argv.rest

  if (!cmd) {
    process.stderr.write('usage: botctl.js hello|list|dry|run|observe|chatdry|restart|schema ...\n')
    process.exit(2)
  }

  const id = makeId()
  let payload

  if (cmd === 'hello') payload = { id, op: controlPlaneContract.CTL_OPS.HELLO }
  else if (cmd === 'list') payload = { id, op: controlPlaneContract.CTL_OPS.TOOL_LIST }
  else if (cmd === 'schema') {
    const target = String(rest[0] || 'ctl')
    const schemaOp = controlPlaneContract.resolveCtlSchemaOp(target)
    if (!schemaOp) {
      process.stderr.write(`usage: botctl.js schema ${schemaTargetsUsage()}\n`)
      process.exit(2)
    }
    payload = { id, op: schemaOp }
  }
  else if (cmd === 'restart') {
    const args = parseKeyValueArgs(rest)
    payload = { id, op: controlPlaneContract.CTL_OPS.PROC_RESTART, args }
  }
  else if (cmd === 'dry' || cmd === 'run') {
    const tool = rest[0]
    if (!tool) {
      process.stderr.write(`usage: botctl.js ${cmd} <tool> [key=value ...]\n`)
      process.exit(2)
    }
    const args = parseKeyValueArgs(rest.slice(1))
    payload = {
      id,
      op: cmd === 'dry' ? controlPlaneContract.CTL_OPS.TOOL_DRY : controlPlaneContract.CTL_OPS.TOOL_RUN,
      tool,
      args
    }
  } else if (cmd === 'chatdry' || cmd === 'ai-dry') {
    const args = parseKeyValueArgs(rest)
    if (!args.content && !args.message && !args.text) {
      process.stderr.write('usage: botctl.js chatdry username=<name> content=<text> [withTools=true] [maxToolCalls=6]\n')
      process.exit(2)
    }
    payload = { id, op: controlPlaneContract.CTL_OPS.AI_CHAT_DRY, args }
  } else if (cmd === 'observe') {
    const mode = String(rest[0] || 'snapshot')
    const args = parseKeyValueArgs(rest.slice(1))
    const observeOp = controlPlaneContract.resolveObserveOp(mode)
    if (!observeOp) {
      process.stderr.write(`usage: botctl.js observe ${observeModesUsage()} [key=value ...]\n`)
      process.exit(2)
    }
    payload = { id, op: observeOp, args }
  } else {
    process.stderr.write(`unknown cmd: ${cmd}\n`)
    process.exit(2)
  }

  if (token && payload) payload.token = token
  const res = await request(sockPath, payload)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
  if (!res || res.ok !== true) process.exit(1)
}

main().catch((err) => {
  process.stderr.write(String(err?.message || err) + '\n')
  process.exit(1)
})
