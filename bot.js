if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai'

const mineflayer = require('mineflayer')
const readline = require('readline')
const net = require('net')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const fileLogger = require('./bot_impl/file-logger')
const { formatDateTimeTz } = require('./bot_impl/time-utils')

// Simple argv parser
function parseArgv () {
  const out = { args: {}, rest: [] }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    const t = a[i]
    if (!t.startsWith('--')) { out.rest.push(t); continue }
    const [kRaw, vRaw] = t.replace(/^--/, '').split('=', 2)
    const k = kRaw.toLowerCase()
    const v = vRaw != null ? vRaw : a[i + 1]
    if (vRaw == null && a[i + 1] && !a[i + 1].startsWith('--')) i++
    out.args[k] = v === undefined ? true : v
  }
  return out
}

const argv = parseArgv()

const fileLog = fileLogger.install()
if (fileLog && fileLog.enabled && fileLog.path) {
  console.log('[LOGFILE] Writing logs to', fileLog.path)
}

function parseDurationMs (raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const durationRe = /^(-?\d+(?:\.\d+)?)(ms|s|m|h)?$/i
  const m = durationRe.exec(s)
  if (!m) return null
  const value = parseFloat(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (m[2] || 'ms').toLowerCase()
  if (unit === 'ms') return Math.round(value)
  if (unit === 's') return Math.round(value * 1000)
  if (unit === 'm') return Math.round(value * 60 * 1000)
  if (unit === 'h') return Math.round(value * 60 * 60 * 1000)
  return null
}

function parseBool (v, defTrue = true) {
  const s = String(v ?? (defTrue ? '1' : '0')).toLowerCase()
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off')
}

// Config (single bot), allow CLI overrides
const options = {
  host: argv.args.host || process.env.MC_HOST,
  port: Number(argv.args.port || process.env.MC_PORT),
  username: argv.args.username || argv.args.user || process.env.MC_USERNAME,
  auth: argv.args.auth || process.env.MC_AUTH || 'offline'
}
if (argv.args.password || process.env.MC_PASSWORD) options.password = argv.args.password || process.env.MC_PASSWORD
// Explicit protocol version (e.g., 1.21.4). Strongly recommended to avoid packet schema mismatches.
if (argv.args.version || process.env.MC_VERSION) options.version = argv.args.version || process.env.MC_VERSION
// Greeting toggle via CLI: --greet on|off
if (argv.args.greet) { process.env.MC_GREET = parseBool(argv.args.greet) ? '1' : '0' }
// Auto-iterate interval override: supports ms/s/m/h suffix
if (argv.args['iterate-interval']) {
  const ms = parseDurationMs(argv.args['iterate-interval'])
  if (ms) process.env.AUTO_ITERATE_INTERVAL_MS = String(ms)
}

const DEBUG = parseBool(process.env.MC_DEBUG, false)
function dlog (...args) { if (DEBUG) console.log('[DEBUG]', ...args) }
function ts () { return formatDateTimeTz() }

console.log('Starting bot with config:', {
  host: options.host,
  port: options.port,
  username: options.username,
  auth: options.auth,
  version: options.version,
  hasPassword: Boolean(options.password),
  debug: DEBUG,
  greet: parseBool(process.env.MC_GREET, true)
})

// Current bot instance (may be recreated on reconnect)
let bot = null

// Reconnect backoff state
let reconnectTimer = null
let reconnectAttempts = 0
const RECONNECT_MAX_DELAY_MS = 30000
const RECONNECT_BASE_DELAY_MS = 1000

function scheduleReconnect(reason) {
  if (shuttingDown) return
  if (reconnectTimer) return
  reconnectAttempts++
  const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts))
  console.log(`[${ts()}] Reconnecting in ${delay}ms (${reason})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startBot()
  }, delay)
}

function attachCoreBotListeners() {
  bot.on('kicked', (reason) => {
    try {
      const m = process.memoryUsage && process.memoryUsage()
      const fmt = (n) => Math.round((n || 0) / (1024 * 1024)) + 'MB'
      const mem = m ? `rss=${fmt(m.rss)} heapUsed=${fmt(m.heapUsed)} heapTotal=${fmt(m.heapTotal)}` : ''
      console.log(`[${ts()}] Kicked by server:`, typeof reason === 'string' ? reason : JSON.stringify(reason), mem)
    } catch {}
    try { if (plugin && typeof plugin.deactivate === 'function') plugin.deactivate() } catch {}
    scheduleReconnect('kicked')
  })
  bot.on('end', (reason) => {
    try {
      const m = process.memoryUsage && process.memoryUsage()
      const fmt = (n) => Math.round((n || 0) / (1024 * 1024)) + 'MB'
      const mem = m ? `rss=${fmt(m.rss)} heapUsed=${fmt(m.heapUsed)} heapTotal=${fmt(m.heapTotal)}` : ''
      console.log(`[${ts()}] Bot connection closed`, reason ? `(${reason})` : '', mem)
    } catch {}
    try { if (plugin && typeof plugin.deactivate === 'function') plugin.deactivate() } catch {}
    scheduleReconnect('end')
  })
  bot.on('error', (err) => {
    console.error('Bot error:', err?.message || err)
  })
}

function startBot() {
  try {
    // Create new bot instance
    bot = mineflayer.createBot(options)
    try { console.log(`[${ts()}] Starting (re)connection...`) } catch {}
    reconnectAttempts = 0 // reset backoff on successful create
    try {
      if (sharedState) sharedState.hasSpawned = false
    } catch {}
    attachCoreBotListeners()
    loadPlugin()
  } catch (e) {
    console.error('Failed to start bot:', e)
    scheduleReconnect('start-failed')
  }
}

// Persistent console input
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  // CLI commands: lines starting with '.' or ':' are handled internally
  if (trimmed.startsWith('.') || trimmed.startsWith(':')) {
    const raw = trimmed.replace(/^[:.]/, '')
    const [cmd, ...args] = raw.split(/\s+/)
    try { bot && bot.emit('cli', { cmd, args, raw }) } catch (e) { console.error('CLI dispatch error:', e) }
    return
  }
  try { bot && bot.chat(trimmed) } catch (e) { console.error('Chat error:', e) }
})

// Hot-reloadable implementation loader (directory-based)
const pluginRoot = path.resolve(__dirname, 'bot_impl')
let plugin = null
let sharedState = { pendingGreets: new Map(), greetedPlayers: new Set(), readyForGreeting: false, extinguishing: false }

// --- Control plane (Unix socket, NDJSON) ---
// Stable IPC for scripts/Codex; avoids fragile stdin attach/quoting.
const ctl = {
  startedAt: Date.now(),
  pidPath: path.resolve(process.cwd(), '.mcbot.pid'),
  sockPath: path.resolve(process.cwd(), '.mcbot.sock'),
  server: null,
  token: null,
  enabled: true
}
let restartPending = false

// Control plane config (UDS). Disable via --ctl off or MCBOT_CTL=off.
try {
  const ctlFlag = argv.args.ctl != null ? String(argv.args.ctl) : (process.env.MCBOT_CTL != null ? String(process.env.MCBOT_CTL) : 'on')
  ctl.enabled = parseBool(ctlFlag, true)
} catch {}
try {
  const tokenArg = argv.args['ctl-token'] != null ? String(argv.args['ctl-token']) : null
  const tokenEnv = process.env.MCBOT_CTL_TOKEN != null ? String(process.env.MCBOT_CTL_TOKEN) : null
  ctl.token = (tokenArg || tokenEnv || '').trim() || null
} catch {}

function safeUnlink (p) {
  try { fs.unlinkSync(p) } catch {}
}

function startControlPlane () {
  if (!ctl.enabled) return
  if (ctl.server) return
  // Best-effort cleanup from previous runs.
  safeUnlink(ctl.sockPath)
  try { fs.writeFileSync(ctl.pidPath, String(process.pid) + '\n') } catch {}

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk
      // Defensive: limit buffered input (NDJSON). Prevents unbounded memory growth on malformed clients.
      if (buf.length > 256 * 1024) {
        try { socket.end() } catch {}
        return
      }
      while (true) {
        const idx = buf.indexOf('\n')
        if (idx < 0) break
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let req
        try { req = JSON.parse(line) } catch { req = null }
        handleCtlRequest(req).then((res) => {
          try { socket.write(JSON.stringify(res) + '\n') } catch {}
        }).catch((err) => {
          const id = req && req.id != null ? req.id : null
          try { socket.write(JSON.stringify({ id, ok: false, error: String(err?.message || err) }) + '\n') } catch {}
        })
      }
    })
  })
  ctl.server = server

  // Ensure the socket is created with restrictive permissions from the start.
  const oldUmask = (() => { try { return process.umask(0o077) } catch { return null } })()
  server.once('listening', () => {
    try { if (oldUmask != null) process.umask(oldUmask) } catch {}
  })
  server.listen(ctl.sockPath, () => {
    try { fs.chmodSync(ctl.sockPath, 0o600) } catch {}
    try {
      const st = fs.lstatSync(ctl.sockPath)
      if (!st.isSocket()) console.error('[CTL] warning: path is not a socket:', ctl.sockPath)
    } catch {}
    console.log('[CTL] listening on', ctl.sockPath)
  })
  server.on('error', (err) => {
    console.error('[CTL] server error:', err?.message || err)
    try { if (oldUmask != null) process.umask(oldUmask) } catch {}
  })
}

function stopControlPlane () {
  if (!ctl.server) return
  try { ctl.server.close() } catch {}
  ctl.server = null
  safeUnlink(ctl.sockPath)
  safeUnlink(ctl.pidPath)
}

function scheduleProcessRestart ({ mode = 'detached', delayMs = 200, reason = 'unknown' } = {}) {
  if (restartPending) return false
  const underWatcher = String(process.env.MCBOT_WATCHER || '').trim() === '1'
  if (underWatcher) {
    restartPending = true
    const waitMs = Number.isFinite(Number(delayMs)) ? Math.max(50, Math.min(10_000, Math.floor(Number(delayMs)))) : 200
    setTimeout(() => {
      try { shuttingDown = true } catch {}
      console.log(`[CTL] watcher-managed restart requested (reason=${reason}); exiting current process`)
      try { stopControlPlane() } catch {}
      try { if (plugin && plugin.deactivate) plugin.deactivate() } catch {}
      try { closeAllWatchers() } catch {}
      try { if (gateWatcher) gateWatcher.close() } catch {}
      try { rl.close() } catch {}
      try { bot && bot.end('Restart requested by control plane') } catch {}
      setTimeout(() => process.exit(0), 120)
    }, waitMs)
    return true
  }
  restartPending = true
  const useMode = String(mode || '').toLowerCase() === 'inherit' ? 'inherit' : 'detached'
  const waitMs = Number.isFinite(Number(delayMs)) ? Math.max(50, Math.min(10_000, Math.floor(Number(delayMs)))) : 200
  setTimeout(() => {
    try { shuttingDown = true } catch {}
    const childArgs = process.argv.slice(1)
    let nextPid = null
    try {
      const child = spawn(process.execPath, childArgs, {
        cwd: process.cwd(),
        env: process.env,
        detached: useMode === 'detached',
        stdio: useMode === 'inherit' ? 'inherit' : 'ignore'
      })
      if (useMode === 'detached') child.unref()
      nextPid = child?.pid
      if (Number.isFinite(nextPid)) {
        try { fs.writeFileSync(ctl.pidPath, String(nextPid) + '\n') } catch {}
      }
      console.log(`[CTL] restarting process (${useMode}, reason=${reason}) -> pid=${nextPid || 'unknown'}`)
    } catch (err) {
      restartPending = false
      try { shuttingDown = false } catch {}
      console.error('[CTL] restart failed:', err?.message || err)
      return
    }
    try { stopControlPlane() } catch {}
    try { if (plugin && plugin.deactivate) plugin.deactivate() } catch {}
    try { closeAllWatchers() } catch {}
    try { if (gateWatcher) gateWatcher.close() } catch {}
    try { rl.close() } catch {}
    try { bot && bot.end('Restart requested by control plane') } catch {}
    setTimeout(() => process.exit(0), 120)
  }, waitMs)
  return true
}

async function handleCtlRequest (req) {
  const id = req && req.id != null ? req.id : null
  const op = req && req.op ? String(req.op) : ''
  if (!op) return { id, ok: false, error: 'missing op' }

  if (ctl.token) {
    const provided = req && req.token != null ? String(req.token) : ''
    if (!provided || provided !== ctl.token) return { id, ok: false, error: 'unauthorized' }
  }

  if (op === 'hello') {
    return {
      id,
      ok: true,
      result: {
        cwd: process.cwd(),
        pid: process.pid,
        startedAt: ctl.startedAt,
        hasBot: Boolean(bot),
        username: bot && bot.username ? bot.username : null
      }
    }
  }

  if (op === 'proc.restart' || op === 'process.restart') {
    const args = (req && req.args && typeof req.args === 'object') ? req.args : {}
    const mode = String(args.mode || 'detached').toLowerCase() === 'inherit' ? 'inherit' : 'detached'
    const delayParsed = parseDurationMs(args.delayMs ?? args.delay)
    const delayMs = Number.isFinite(delayParsed) ? delayParsed : 200
    const scheduled = scheduleProcessRestart({ mode, delayMs, reason: 'ctl' })
    if (!scheduled) return { id, ok: false, error: 'restart already pending' }
    return {
      id,
      ok: true,
      result: {
        scheduled: true,
        mode,
        delayMs,
        pid: process.pid
      }
    }
  }

  if (!bot) return { id, ok: false, error: 'bot not ready' }

  if (op === 'ai.chat.dry' || op === 'chat.dry') {
    const args = (req && req.args && typeof req.args === 'object') ? req.args : {}
    const username = String(args.username || args.user || args.player || 'dry_user').trim() || 'dry_user'
    const content = String(args.content || args.message || args.text || '').trim()
    if (!content) return { id, ok: false, error: 'missing content' }
    const executor = bot && bot._aiChatExecutor
    if (!executor || typeof executor.dryDialogue !== 'function') {
      return { id, ok: false, error: 'ai chat executor not ready' }
    }
    const withTools = args.withTools == null ? true : parseBool(args.withTools, true)
    const maxToolCallsRaw = Number(args.maxToolCalls)
    const options = { withTools }
    if (Number.isFinite(maxToolCallsRaw)) options.maxToolCalls = maxToolCallsRaw
    const result = await executor.dryDialogue(username, content, options)
    return { id, ok: true, result }
  }

  if (op === 'observe.snapshot' || op === 'observe.prompt' || op === 'observe.detail') {
    // Require inside handler so hot reload cache clears stay consistent.
    // eslint-disable-next-line import/no-dynamic-require
    const observer = require(path.join(pluginRoot, 'agent', 'observer'))
    const args = (req && req.args && typeof req.args === 'object') ? req.args : {}

    if (op === 'observe.snapshot') {
      return { id, ok: true, result: observer.snapshot(bot, args) }
    }

    if (op === 'observe.prompt') {
      const snap = observer.snapshot(bot, args)
      const prompt = typeof observer.toPrompt === 'function' ? observer.toPrompt(snap) : ''
      return { id, ok: true, result: { prompt, snapshot: snap } }
    }

    if (op === 'observe.detail') {
      const r = typeof observer.detail === 'function'
        ? await Promise.resolve(observer.detail(bot, args))
        : { ok: false, msg: 'observe.detail unsupported' }
      return { id, ok: true, result: r }
    }
  }

  if (op === 'tool.list' || op === 'tool.dry' || op === 'tool.run') {
    // Require inside handler so hot reload cache clears stay consistent.
    // eslint-disable-next-line import/no-dynamic-require
    const actionsMod = require(path.join(pluginRoot, 'actions'))
    const actions = actionsMod.install(bot, { log: null })

    if (op === 'tool.list') {
      const registered = actions.list()
      const allowlist = Array.isArray(actionsMod.TOOL_NAMES) ? actionsMod.TOOL_NAMES : []
      const regSet = new Set(registered)
      return {
        id,
        ok: true,
        result: {
          allowlist,
          registered,
          missing: allowlist.filter(n => !regSet.has(n)),
          extra: registered.filter(n => !allowlist.includes(n))
        }
      }
    }

    const tool = req && req.tool != null ? String(req.tool) : ''
    const args = (req && req.args && typeof req.args === 'object') ? req.args : {}
    if (!tool) return { id, ok: false, error: 'missing tool' }
    const allowlist = Array.isArray(actionsMod.TOOL_NAMES) ? actionsMod.TOOL_NAMES : []
    if (!allowlist.includes(tool)) return { id, ok: false, error: `tool not allowlisted: ${tool}` }

    if (op === 'tool.dry') {
      const r = actions.dry ? await actions.dry(tool, args) : { ok: false, msg: 'dry-run unsupported' }
      return { id, ok: true, result: r }
    }

    // tool.run
    try { bot.emit('external:begin', { source: 'ctl', tool }) } catch {}
    let r
    try {
      r = await actions.run(tool, args)
    } finally {
      try { bot.emit('external:end', { source: 'ctl', tool }) } catch {}
    }
    return { id, ok: true, result: r }
  }

  return { id, ok: false, error: `unknown op: ${op}` }
}
// Optional: reload gate file to control when hot-reload applies
function resolveReloadGate () {
  const arg = argv.args['reload-gate']
  const env = process.env.HOT_RELOAD_GATE
  // Default: gate ON using 'open_fire' unless explicitly disabled
  let v = (arg != null) ? String(arg) : (env != null ? String(env) : 'open_fire')
  const s = String(v).toLowerCase()
  if (s === '0' || s === 'off' || s === 'false' || s === 'no' || s === 'disable' || s === 'disabled') return null
  if (s === '' || s === '1' || s === 'on' || s === 'true' || s === 'yes') v = 'open_fire'
  return path.resolve(process.cwd(), v)
}
const reloadGatePath = resolveReloadGate()
let gateWatcher = null
let pendingReload = false
const GATE_TRIGGER_DELAY_MS = 60
const GATE_DUPLICATE_SUPPRESS_MS = 1500
const GATE_SAME_MTIME_RETRY_MS = 1200
let gateReloadTimer = null
let lastGateReloadAt = 0
let lastGateMtimeMs = 0
if (reloadGatePath) {
  try {
    const stat = fs.statSync(reloadGatePath)
    if (stat && Number.isFinite(stat.mtimeMs)) lastGateMtimeMs = stat.mtimeMs
  } catch {}
}

function clearPluginCache() {
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(pluginRoot + path.sep)) delete require.cache[id]
  }
}

function loadPlugin() {
  // Transactional-ish reload: only deactivate old after new module loads
  let next = null
  try { clearPluginCache() } catch {}
  try {
    next = require(pluginRoot) // resolves to bot_impl/index.js
  } catch (e) {
    console.error('Hot reload: require failed; keeping previous implementation active:', e?.message || e)
    return
  }

  // Swap: deactivate previous, then activate next
  try {
    if (plugin && typeof plugin.deactivate === 'function') {
      dlog('Deactivating previous implementation...')
      plugin.deactivate()
    }
  } catch (e) {
    console.error('Error during previous deactivate:', e)
  }

  try {
    plugin = next
    const res = plugin.activate(bot, { sharedState, config: { password: options.password } })
    if (res && res.sharedState) sharedState = res.sharedState
    console.log('Loaded bot implementation from', path.basename(pluginRoot))
  } catch (e) {
    console.error('Hot reload: activation failed:', e?.message || e)
  }
}

startControlPlane()

startBot()

// Watch the entire plugin directory recursively and reload on change
let reloadTimer = null
const watchers = new Map()
let shuttingDown = false

function debounceReload(label) {
  if (reloadGatePath) {
    // Gate enabled: mark pending and instruct operator how to trigger
    pendingReload = true
    console.log('Detected change in', label, '- gated. Touch', path.basename(reloadGatePath), 'to apply reload.')
    return
  }
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    console.log('Detected change in', label, '- reloading...')
    loadPlugin()
  }, 120)
}

function watchReloadGate() {
  if (!reloadGatePath || gateWatcher) return
  try {
    const gateDir = path.dirname(reloadGatePath)
    const gateBase = path.basename(reloadGatePath)
    const scheduleGateReload = () => {
      if (gateReloadTimer) return
      gateReloadTimer = setTimeout(() => {
        gateReloadTimer = null
        lastGateReloadAt = Date.now()
        console.log('Reload gate touched -> applying reload now')
        loadPlugin()
      }, GATE_TRIGGER_DELAY_MS)
    }
    gateWatcher = fs.watch(gateDir, { persistent: true }, (event, filename) => {
      if (!filename) return
      const fname = filename.toString()
      if (fname !== gateBase) return
      const hadPending = pendingReload
      pendingReload = false
      const now = Date.now()
      if (gateReloadTimer) return
      fs.promises.stat(reloadGatePath).then((stat) => {
        const mtimeMs = Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : (stat?.mtime instanceof Date ? stat.mtime.getTime() : NaN)
        if (!hadPending) {
          if (lastGateReloadAt && now - lastGateReloadAt < GATE_DUPLICATE_SUPPRESS_MS) return
          if (Number.isFinite(lastGateMtimeMs) && Number.isFinite(mtimeMs)) {
            if (mtimeMs < lastGateMtimeMs - 1) return
            if (mtimeMs <= lastGateMtimeMs + 1 && now - lastGateReloadAt < GATE_SAME_MTIME_RETRY_MS) return
          } else if (!Number.isFinite(mtimeMs) && lastGateReloadAt && now - lastGateReloadAt < GATE_DUPLICATE_SUPPRESS_MS) {
            return
          }
        }
        if (Number.isFinite(mtimeMs)) {
          if (!Number.isFinite(lastGateMtimeMs) || mtimeMs > lastGateMtimeMs) {
            lastGateMtimeMs = mtimeMs
          } else {
            lastGateMtimeMs = Math.max(lastGateMtimeMs, mtimeMs)
          }
        } else if (!Number.isFinite(lastGateMtimeMs)) {
          lastGateMtimeMs = now
        }
        scheduleGateReload()
      }).catch(() => {
        if (!hadPending && lastGateReloadAt && now - lastGateReloadAt < GATE_DUPLICATE_SUPPRESS_MS) return
        scheduleGateReload()
      })
    })
    console.log('Hot reload gate enabled at', reloadGatePath, '(touch to reload)')
  } catch (e) {
    console.error('Failed to watch reload gate:', e?.message || e)
  }
}

function watchDirRecursive(dir) {
  if (watchers.has(dir)) return
  try {
    const watcher = fs.watch(dir, { persistent: true }, (event, filename) => {
      if (!filename) { debounceReload(dir); return }
      const full = path.join(dir, filename.toString())
      debounceReload(path.relative(pluginRoot, full) || 'plugin')
      // If a new directory is added, start watching it too
      fs.promises.stat(full).then(stat => {
        if (stat.isDirectory()) watchDirRecursive(full)
      }).catch(() => {})
    })
    watchers.set(dir, watcher)
    fs.readdirSync(dir, { withFileTypes: true }).forEach((de) => {
      if (de.name === 'node_modules' || de.name.startsWith('.git')) return
      if (de.isDirectory()) watchDirRecursive(path.join(dir, de.name))
    })
  } catch (e) {
    console.error('Watcher error on', dir, e)
  }
}

watchDirRecursive(pluginRoot)
console.log('Hot reload watching directory', path.basename(pluginRoot))
watchReloadGate()

function closeAllWatchers() {
  for (const [dir, w] of watchers) {
    try { w.close() } catch {}
  }
  watchers.clear()
}

process.on('SIGINT', () => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('Shutting down bot...')
  try { stopControlPlane() } catch {}
  try { if (plugin && plugin.deactivate) plugin.deactivate() } catch {}
  try { closeAllWatchers() } catch {}
  try { if (gateWatcher) gateWatcher.close() } catch {}
  try { rl.close() } catch {}
  try {
    bot && bot.once('end', () => {
      setTimeout(() => process.exit(0), 0)
    })
    bot && bot.end('Interrupt received')
  } catch {}
  // Safety timeout in case 'end' never fires
  setTimeout(() => process.exit(0), 2000)
})

process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason)
})
