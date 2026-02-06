#!/usr/bin/env node

// Interaction contract verifier (control plane + observer + tool dry-run).
//
// This script is intended to be the fastest closed-loop check after a change:
// 1) control plane is reachable
// 2) tool registry is coherent
// 3) observer endpoints return structured data
// 4) tool dry-run path is functional

const net = require('net')
const path = require('path')

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

function parseNum (v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function makeId (prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`
}

function request (sockPath, payload, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: sockPath })
    socket.setEncoding('utf8')
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      reject(new Error(`request timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    const done = (err, res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.end() } catch {}
      if (err) reject(err)
      else resolve(res)
    }

    socket.on('error', (err) => done(err))
    socket.on('connect', () => {
      try { socket.write(JSON.stringify(payload) + '\n') } catch (e) { done(e) }
    })
    socket.on('data', (chunk) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      const line = buf.slice(0, idx).trim()
      if (!line) return done(new Error('empty response'))
      try {
        done(null, JSON.parse(line))
      } catch (e) {
        done(e)
      }
    })
  })
}

async function call (sockPath, token, op, extra = {}) {
  const payload = { id: makeId(op.replace(/\./g, '_')), op, ...(extra || {}) }
  if (token) payload.token = token
  const startedAt = Date.now()
  const res = await request(sockPath, payload)
  const durationMs = Date.now() - startedAt
  return { res, durationMs }
}

function ensureCtlOk (label, res) {
  if (!res || res.ok !== true) {
    const err = res && res.error ? String(res.error) : 'unknown error'
    throw new Error(`${label} failed: ${err}`)
  }
}

async function main () {
  const argv = parseArgv()
  const sockPath = argv.flags.sock ? path.resolve(String(argv.flags.sock)) : path.resolve(process.cwd(), '.mcbot.sock')
  const token = argv.flags.token != null ? String(argv.flags.token) : (process.env.MCBOT_CTL_TOKEN != null ? String(process.env.MCBOT_CTL_TOKEN) : '')
  const dryTool = String(argv.flags.tool || 'pickup')
  const radius = parseNum(argv.flags.radius, 12)
  const detailWhat = String(argv.flags.detail || 'inventory')

  const checks = []

  const hello = await call(sockPath, token, 'hello')
  ensureCtlOk('hello', hello.res)
  checks.push({ check: 'hello', ok: true, durationMs: hello.durationMs, result: hello.res.result })

  const list = await call(sockPath, token, 'tool.list')
  ensureCtlOk('tool.list', list.res)
  const allowlist = Array.isArray(list.res?.result?.allowlist) ? list.res.result.allowlist : []
  if (!allowlist.includes(dryTool)) {
    throw new Error(`tool.list failed: dry tool not allowlisted: ${dryTool}`)
  }
  checks.push({
    check: 'tool.list',
    ok: true,
    durationMs: list.durationMs,
    result: {
      allowlistCount: allowlist.length,
      missingCount: Array.isArray(list.res?.result?.missing) ? list.res.result.missing.length : 0,
      extraCount: Array.isArray(list.res?.result?.extra) ? list.res.result.extra.length : 0
    }
  })

  const snapshot = await call(sockPath, token, 'observe.snapshot', {
    args: { invTop: 8, nearPlayerRange: 16, nearPlayerMax: 8, dropsRange: 8, dropsMax: 8 }
  })
  ensureCtlOk('observe.snapshot', snapshot.res)
  checks.push({
    check: 'observe.snapshot',
    ok: true,
    durationMs: snapshot.durationMs,
    result: {
      hasPos: Boolean(snapshot.res?.result?.pos),
      dim: snapshot.res?.result?.dim || null,
      hasTask: Boolean(snapshot.res?.result?.task)
    }
  })

  const prompt = await call(sockPath, token, 'observe.prompt', {
    args: { nearPlayerRange: 16, hostileRange: 24 }
  })
  ensureCtlOk('observe.prompt', prompt.res)
  const promptText = String(prompt.res?.result?.prompt || '')
  checks.push({
    check: 'observe.prompt',
    ok: true,
    durationMs: prompt.durationMs,
    result: {
      promptLength: promptText.length,
      hasGamePrefix: promptText.startsWith('游戏:')
    }
  })

  const detail = await call(sockPath, token, 'observe.detail', {
    args: { what: detailWhat, radius, max: 24 }
  })
  ensureCtlOk('observe.detail', detail.res)
  checks.push({
    check: 'observe.detail',
    ok: true,
    durationMs: detail.durationMs,
    result: {
      detailOk: Boolean(detail.res?.result?.ok),
      msg: detail.res?.result?.msg || ''
    }
  })

  const dry = await call(sockPath, token, 'tool.dry', {
    tool: dryTool,
    args: { radius }
  })
  ensureCtlOk('tool.dry', dry.res)
  checks.push({
    check: 'tool.dry',
    ok: true,
    durationMs: dry.durationMs,
    result: {
      tool: dryTool,
      dryOk: Boolean(dry.res?.result?.ok),
      capability: dry.res?.result?.capability?.level || null,
      msg: dry.res?.result?.msg || ''
    }
  })

  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sockPath,
    checks
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
}

main().catch((err) => {
  process.stderr.write(`interaction dry-run failed: ${String(err?.message || err)}\n`)
  process.exit(1)
})

