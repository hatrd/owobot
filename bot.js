const mineflayer = require('mineflayer')
const readline = require('readline')
const fs = require('fs')
const path = require('path')

// Config
const options = {
  host: process.env.MC_HOST,
  port: Number(process.env.MC_PORT),
  username: process.env.MC_USERNAME,
  auth: process.env.MC_AUTH || 'offline'
}
if (process.env.MC_PASSWORD) options.password = process.env.MC_PASSWORD

const DEBUG = (() => {
  const v = String(process.env.MC_DEBUG ?? '1').toLowerCase()
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off')
})()
function dlog (...args) { if (DEBUG) console.log('[DEBUG]', ...args) }

console.log('Starting bot with config:', {
  host: options.host,
  port: options.port,
  username: options.username,
  auth: options.auth,
  hasPassword: Boolean(options.password),
  debug: DEBUG
})

// Create a single bot instance that stays connected
const bot = mineflayer.createBot(options)

// Persistent console input
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  // CLI commands: lines starting with '.' or ':' are handled internally
  if (trimmed.startsWith('.') || trimmed.startsWith(':')) {
    const raw = trimmed.replace(/^[:.]/, '')
    const [cmd, ...args] = raw.split(/\s+/)
    try { bot.emit('cli', { cmd, args, raw }) } catch (e) { console.error('CLI dispatch error:', e) }
    return
  }
  try { bot.chat(trimmed) } catch (e) { console.error('Chat error:', e) }
})

// Hot-reloadable implementation loader (directory-based)
const pluginRoot = path.resolve(__dirname, 'bot_impl')
let plugin = null
let sharedState = { pendingGreets: new Map(), greetedPlayers: new Set(), readyForGreeting: false, extinguishing: false }

function clearPluginCache() {
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(pluginRoot + path.sep)) delete require.cache[id]
  }
}

function loadPlugin() {
  try {
    if (plugin && typeof plugin.deactivate === 'function') {
      dlog('Deactivating previous implementation...')
      plugin.deactivate()
    }
  } catch (e) {
    console.error('Error during previous deactivate:', e)
  }
  try {
    clearPluginCache()
  } catch {}
  try {
    plugin = require(pluginRoot) // resolves to bot_impl/index.js
    const res = plugin.activate(bot, { sharedState })
    if (res && res.sharedState) sharedState = res.sharedState
    console.log('Loaded bot implementation from', path.basename(pluginRoot))
  } catch (e) {
    console.error('Failed to load bot implementation:', e)
  }
}

loadPlugin()

// Watch the entire plugin directory recursively and reload on change
let reloadTimer = null
const watchers = new Map()
let shuttingDown = false

function debounceReload(label) {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    console.log('Detected change in', label, '- reloading...')
    loadPlugin()
  }, 120)
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
  try { rl.close() } catch {}
  try {
    bot.once('end', () => {
      setTimeout(() => process.exit(0), 0)
    })
    bot.end('Interrupt received')
  } catch {}
  // Safety timeout in case 'end' never fires
  setTimeout(() => process.exit(0), 2000)
})

process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason)
})
