#!/usr/bin/env node

const fs = require('fs')
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

function parseBool (value, fallback = false) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (!text) return fallback
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false
  return fallback
}

function makeId (prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`
}

function request (sockPath, payload, timeoutMs = 8000) {
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

    socket.on('error', done)
    socket.on('connect', () => {
      try { socket.write(JSON.stringify(payload) + '\n') } catch (err) { done(err) }
    })
    socket.on('data', (chunk) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      const line = buf.slice(0, idx).trim()
      if (!line) return done(new Error('empty response'))
      try {
        done(null, JSON.parse(line))
      } catch (err) {
        done(err)
      }
    })
  })
}

async function call (sockPath, token, op, timeoutMs = 8000) {
  const payload = { id: makeId(op.replace(/\./g, '_')), op }
  if (token) payload.token = token
  const res = await request(sockPath, payload, timeoutMs)
  if (!res || res.ok !== true) {
    throw new Error(`${op} failed: ${String(res?.error || 'unknown error')}`)
  }
  return res.result
}

function escapeCell (value) {
  return String(value == null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br/>')
}

function formatOpsTable (ctlSchema) {
  const ops = Array.isArray(ctlSchema?.ops) ? ctlSchema.ops : []
  const lines = []
  lines.push('| op | aliases | requiresBot | description |')
  lines.push('| --- | --- | --- | --- |')
  for (const item of ops) {
    const aliases = Array.isArray(item?.aliases) ? item.aliases.join(', ') : ''
    lines.push(`| ${escapeCell(item?.op)} | ${escapeCell(aliases)} | ${item?.requiresBot ? 'yes' : 'no'} | ${escapeCell(item?.description || '')} |`)
  }
  return lines.join('\n')
}

function formatObserveTable (observeSchema) {
  const rows = Array.isArray(observeSchema?.supported) ? observeSchema.supported : []
  const lines = []
  lines.push('| what | description |')
  lines.push('| --- | --- |')
  for (const row of rows) {
    lines.push(`| ${escapeCell(row?.what)} | ${escapeCell(row?.description || '')} |`)
  }
  return lines.join('\n')
}

function formatObserveAliases (observeSchema) {
  const aliases = Array.isArray(observeSchema?.aliases) ? observeSchema.aliases : []
  if (!aliases.length) return '- (none)'
  return aliases
    .map(item => `- \`${item.alias}\` -> \`${item.canonical}\``)
    .join('\n')
}

function formatToolTable (toolSchema) {
  const tools = Array.isArray(toolSchema?.tools) ? toolSchema.tools : []
  const lines = []
  lines.push('| tool | dryCapability | hasSchema | description |')
  lines.push('| --- | --- | --- | --- |')
  for (const tool of tools) {
    const hasSchema = Boolean(tool?.description)
    lines.push(`| ${escapeCell(tool?.name)} | ${escapeCell(tool?.dryCapability || 'validate_only')} | ${hasSchema ? 'yes' : 'no'} | ${escapeCell(tool?.description || '')} |`)
  }
  return lines.join('\n')
}

function renderMarkdown ({ source, ctlSchema, observeSchema, toolSchema }) {
  const nowIso = new Date().toISOString()
  const missing = Array.isArray(toolSchema?.report?.missingSchema) ? toolSchema.report.missingSchema : []
  const stale = Array.isArray(toolSchema?.report?.staleSchema) ? toolSchema.report.staleSchema : []
  return [
    '# Interaction Schema (Generated)',
    '',
    `- GeneratedAt: \`${nowIso}\``,
    `- Source: \`${source}\``,
    '',
    '## Control Ops',
    '',
    formatOpsTable(ctlSchema),
    '',
    '## observe.detail what',
    '',
    formatObserveTable(observeSchema),
    '',
    '### Aliases',
    '',
    formatObserveAliases(observeSchema),
    '',
    '## Tool Schema',
    '',
    formatToolTable(toolSchema),
    '',
    '### Coverage Report',
    '',
    `- allowlistCount: ${Number(toolSchema?.report?.allowlistCount || 0)}`,
    `- missingSchema: ${missing.length ? missing.map(name => `\`${name}\``).join(', ') : '(none)'}`,
    `- staleSchema: ${stale.length ? stale.map(name => `\`${name}\``).join(', ') : '(none)'}`,
    ''
  ].join('\n')
}

function loadOfflineSchemas () {
  const mod = require(path.join(__dirname, '..', 'bot_impl', 'interaction-schema'))
  return {
    source: 'offline-module',
    ctlSchema: mod.getCtlSchema(),
    observeSchema: mod.getObserveSchema(),
    toolSchema: mod.getToolSchema()
  }
}

async function loadSocketSchemas ({ sockPath, token, timeoutMs }) {
  return {
    source: `socket:${sockPath}`,
    ctlSchema: await call(sockPath, token, 'ctl.schema', timeoutMs),
    observeSchema: await call(sockPath, token, 'observe.schema', timeoutMs),
    toolSchema: await call(sockPath, token, 'tool.schema', timeoutMs)
  }
}

async function main () {
  const argv = parseArgv()
  const outPath = argv.flags.out
    ? path.resolve(String(argv.flags.out))
    : path.resolve(process.cwd(), 'docs', 'interaction.generated.md')
  const sockPath = argv.flags.sock
    ? path.resolve(String(argv.flags.sock))
    : path.resolve(process.cwd(), '.mcbot.sock')
  const token = argv.flags.token != null
    ? String(argv.flags.token)
    : (process.env.MCBOT_CTL_TOKEN != null ? String(process.env.MCBOT_CTL_TOKEN) : '')
  const timeoutMs = Number.isFinite(Number(argv.flags['timeout-ms'])) ? Math.max(1000, Number(argv.flags['timeout-ms'])) : 8000
  const forceOffline = parseBool(argv.flags.offline, false)
  const fallbackOffline = parseBool(argv.flags['fallback-offline'], true)

  let schemas
  if (forceOffline) {
    schemas = loadOfflineSchemas()
  } else {
    try {
      schemas = await loadSocketSchemas({ sockPath, token, timeoutMs })
    } catch (err) {
      if (!fallbackOffline) throw err
      process.stderr.write(`[docgen] socket mode failed (${String(err?.message || err)}), fallback to offline module.\n`)
      schemas = loadOfflineSchemas()
    }
  }

  const markdown = renderMarkdown(schemas)
  fs.writeFileSync(outPath, markdown)
  process.stdout.write(`[docgen] wrote ${outPath}\n`)
}

main().catch((err) => {
  process.stderr.write(`[docgen] failed: ${String(err?.message || err)}\n`)
  process.exit(1)
})
