if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai'

const mineflayer = require('mineflayer')
const readline = require('readline')
const fs = require('fs')
const path = require('path')
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
