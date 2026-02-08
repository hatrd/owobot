// Hot-reloadable bot implementation. The loader (bot.js) will call activate/deactivate

let bot = null
const fs = require('fs')
const { Vec3 } = require('vec3')
const logging = require('./logging')
const { MODULES } = require('./module-registry')
const { prepareSharedState } = require('./state')
const greetings = require('./greetings')
const watchers = require('./watchers')
const coreLog = logging.getLogger('core')

function dlog (...args) { coreLog.debug(...args) }
function ts () { return new Date().toISOString() }

// Shared state comes from loader to preserve across reloads
let state = null
let greetingManager = null
let watcherManager = null

// Listener references and timers for cleanup
const listeners = []
let teleportResetPromise = null
const TELEPORT_CHAT_COMMANDS = new Set(['tpa', 'tpaccept', 'tpahere', 'back', 'home', 'spawn', 'warp', 'rtp'])
const CHAT_DISABLED_PATTERN = /chat disabled in client options/i

function isTeleportChatCommandText (text) {
  try {
    const trimmed = String(text || '').trim()
    if (!trimmed.startsWith('/')) return false
    const cmd = trimmed.slice(1).split(/\s+/, 1)[0].toLowerCase()
    return TELEPORT_CHAT_COMMANDS.has(cmd)
  } catch {
    return false
  }
}
function initAfterSpawn() {
  try {
    greetingManager?.onSpawn()
  } catch (err) {
    coreLog.warn('greeting init error:', err?.message || err)
  }
  try {
    watcherManager?.onSpawn()
  } catch (err) {
    coreLog.warn('watcher init error:', err?.message || err)
  }
  state.hasSpawned = true
}

async function hardReset (reason) {
  try {
    // Clear shared flags that could block behaviors
    if (state) {
      state.externalBusy = false
      state.externalBusyCount = 0
      state.holdItemLock = null
      state.autoLookSuspended = false
      state.currentTask = null
    }
  } catch {}
  try {
    // immediate local stop (even if actions fail)
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch {}
    // Use actions.stop(hard) to broadcast agent:stop_all and cancel digging/movement/windows, etc.
    const actions = require('./actions').install(bot, { log: logging.getLogger('core') })
    await actions.run('reset', {})
  } catch (e) {
    try { console.log('hardReset error:', e?.message || e) } catch {}
  }
}

function resetBeforeTeleportCommand () {
  if (teleportResetPromise) return teleportResetPromise
  teleportResetPromise = (async () => {
    try {
      await hardReset('pre-tpa')
    } catch (err) {
      try { coreLog.warn('pre-tpa reset error:', err?.message || err) } catch {}
    } finally {
      teleportResetPromise = null
    }
  })()
  return teleportResetPromise
}

function on(event, handler) {
  bot.on(event, handler)
  listeners.push({ event, handler })
}

function offAll() {
  for (const { event, handler } of listeners.splice(0)) {
    try { bot.off(event, handler) } catch {}
  }
}

function activate (botInstance, options = {}) {
  bot = botInstance
  // Raise listener limits to avoid MaxListeners warnings under heavy dig/reload cycles
  try {
    const EE = require('events')
    if (EE && typeof EE.defaultMaxListeners === 'number' && EE.defaultMaxListeners < 50) EE.defaultMaxListeners = 50
  } catch {}
  try { if (typeof bot.setMaxListeners === 'function') bot.setMaxListeners(50) } catch {}
  try { if (bot._client && typeof bot._client.setMaxListeners === 'function') bot._client.setMaxListeners(50) } catch {}
  const GREET = (() => {
    const v = String(process.env.MC_GREET ?? '1').toLowerCase()
    return !(v === '0' || v === 'false' || v === 'no' || v === 'off')
  })()

  let configuredPassword
  try {
    configuredPassword = options?.config?.password || process.env.MC_PASSWORD || undefined
  } catch {}

  state = prepareSharedState(options.sharedState, { greetEnabled: GREET, loginPassword: configuredPassword })
  // Bind logging to shared state so .log changes persist across reloads
  try { logging.init(state) } catch {}
  // expose shared state on bot for modules that only receive bot
  try { bot.state = state } catch {}

  function registerCleanup (fn) {
    try { if (typeof fn === 'function') state.cleanups.push(fn) } catch {}
  }

  if (!state.chatTeleportPatched) {
    const tryInstallChatIntercept = () => {
      if (state.chatTeleportPatched) return true
      if (!bot || typeof bot.chat !== 'function') return false
      const originalChat = bot.chat.bind(bot)
      bot.chat = function patchedChat (...args) {
        try {
          const raw = args[0]
          const text = typeof raw === 'string' ? raw : (raw != null ? String(raw) : '')
          if (isTeleportChatCommandText(text)) {
            resetBeforeTeleportCommand()
              .catch(() => {})
              .finally(() => {
                try { originalChat(...args) } catch (err) { try { coreLog.warn('chat send error:', err?.message || err) } catch {} }
              })
            return
          }
        } catch (err) {
          try { coreLog.warn('chat intercept error:', err?.message || err) } catch {}
        }
        return originalChat(...args)
      }
      state.chatTeleportPatched = true
      return true
    }
    const installed = tryInstallChatIntercept()
    if (!installed) {
      // Mineflayer may attach chat later during startup; retry quietly before warning
      setTimeout(() => {
        if (state.chatTeleportPatched) return
        if (!tryInstallChatIntercept()) {
          try { coreLog.warn('chat intercept unavailable: bot.chat still missing') } catch {}
        }
      }, 1000)
      try { on('spawn', tryInstallChatIntercept) } catch {}
    }
  }

  state.greetZonesSeeded = false
  try {
    greetingManager = greetings.install(bot, { state, on, registerCleanup, dlog })
  } catch (err) {
    coreLog.warn('greeting install error:', err?.message || err)
  }
  try {
    watcherManager = watchers.install(bot, { state, on, registerCleanup, dlog })
  } catch (err) {
    coreLog.warn('watcher install error:', err?.message || err)
  }
  try {
    const invLabels = require('./agent/inventory-label-cache')
    invLabels.install(bot, { state, on, registerCleanup, log: logging.getLogger('invlabels') })
  } catch (err) {
    coreLog.warn('inv label cache install error:', err?.message || err)
  }

  // Track current external task for AI context (source: chat/cli -> player/auto)
  on('external:begin', (info) => {
    try {
      const src = String(info?.source || '').toLowerCase()
      const source = (src === 'chat' || src === 'cli') ? 'player' : 'auto'
      const count = Number.isFinite(state.externalBusyCount) ? state.externalBusyCount : 0
      state.externalBusyCount = count + 1
      state.externalBusy = true
      state.currentTask = { name: String(info?.tool || info?.name || 'unknown'), source, startedAt: Date.now() }
    } catch {}
  })
  on('external:end', (info) => {
    try {
      const count = Number.isFinite(state.externalBusyCount) ? state.externalBusyCount : 0
      state.externalBusyCount = count > 0 ? count - 1 : 0
      if (state.externalBusyCount === 0) state.externalBusy = false
      const endTool = String(info?.tool || '').toLowerCase()
      const cur = state.currentTask && String(state.currentTask.name || '').toLowerCase()
      // Only clear if names match or no current task; avoid clearing tasks started by another module (e.g., skills)
      if (!cur || !endTool || cur === endTool) {
        state.currentTask = null
      }
    } catch {}
  })

  // Event: display server messages
  let chatDisabledTriggered = false
  function extractPlainText (message) {
    try {
      const text = typeof message.getText === 'function'
        ? message.getText()
        : (typeof message.toString === 'function' ? message.toString() : String(message))
      if (!text) return ''
      return String(text).replace(/\u00a7./g, '')
    } catch (err) {
      try { coreLog.warn('message text extract error:', err?.message || err) } catch {}
      return ''
    }
  }

  function handleChatDisabled (plainText) {
    if (chatDisabledTriggered) return
    chatDisabledTriggered = true
    try {
      state.lastChatDisabledAt = Date.now()
      state.lastChatDisabledMessage = plainText
    } catch {}
    const reason = 'Server reported chat disabled; forcing reconnect'
    try { coreLog.warn(`${reason}. message="${plainText}"`) } catch {}
    try { console.log(`[${ts()}] ${reason}`) } catch {}
    try {
      if (typeof bot.quit === 'function') {
        bot.quit('chat disabled in client options')
      } else if (typeof bot.end === 'function') {
        bot.end('chat disabled in client options')
      } else if (bot._client && typeof bot._client.end === 'function') {
        bot._client.end('chat disabled in client options')
      }
    } catch (err) {
      try { coreLog.warn('Failed to terminate bot after chat disabled:', err?.message || err) } catch {}
    }
  }

  on('message', (message) => {
    try {
      const rendered = typeof message.toAnsi === 'function' ? message.toAnsi() : String(message)
      const max = 800
      const out = rendered.length > max ? (rendered.slice(0, max - 1) + '…') : rendered
      console.log(out)
    } catch (e) {
      try { console.log(String(message)) } catch {}
    }
    try {
      const plain = extractPlainText(message)
      if (plain && CHAT_DISABLED_PATTERN.test(plain)) {
        handleChatDisabled(plain)
      }
    } catch {}
  })

  function installModule (entry) {
    if (!entry || entry.enabled === false) return
    const { id, path: modulePath, logger, description, inject } = entry
    const label = id || modulePath
    try {
      const mod = require(modulePath)
      if (!mod || typeof mod.install !== 'function') {
        coreLog.warn(`module ${label} missing install()`)
        return
      }
      const logName = logger || label
      const baseOptions = { on, dlog, state, registerCleanup, log: logging.getLogger(logName) }
      const options = inject ? Object.assign({}, baseOptions, inject({ on, dlog, state, registerCleanup, logging })) : baseOptions
      mod.install(bot, options)
      if (description) dlog(`Module ready: ${label} - ${description}`)
    } catch (e) {
      coreLog.warn(`${label} install error:`, e?.message || e)
    }
  }

  MODULES.forEach(installModule)

  // Feature removed: random walk (was unstable)

  // Agent: skill runner (high-level intent executor)
  try {
    const runner = require('./agent/runner').install(bot, { on, registerCleanup, log: logging.getLogger('skill') })
    // lazy register core skills (no placeholders)
    try {
      runner.registerSkill('go', require('./skills/go'))
      runner.registerSkill('gather', require('./skills/gather'))
      runner.registerSkill('craft', require('./skills/craft'))
      runner.registerSkill('mine_ore', require('./skills/mine-ore'))
    } catch {}
    // Reflect runner tasks into shared state for observer/.status after hot-reload
    try {
      on('skill:start', (ev) => { try { state.currentTask = { name: String(ev?.name || ''), source: 'auto', startedAt: ev?.createdAt || Date.now() } } catch {} })
      on('skill:end', (ev) => { try { if (state.currentTask && state.currentTask.name === ev?.name) state.currentTask = null } catch {} })
      // On reload, if tasks already running, expose one to state.currentTask
      try {
        const tasks = runner.listTasks && runner.listTasks()
        const running = Array.isArray(tasks) ? tasks.find(t => t.status === 'running') : null
        if (running) state.currentTask = { name: String(running.name || 'skill'), source: 'auto', startedAt: running.createdAt || Date.now() }
      } catch {}
    } catch {}
  } catch (e) { coreLog.warn('skill runner install error:', e?.message || e) }

  // Debug: drops scanner CLI
  // CLI modules registered via MODULES

  on('spawn', () => {
    const host = (bot._client && (bot._client.socketServerHost || bot._client.host)) || 'server'
    const port = (bot._client && bot._client.port) || ''
    console.log(`[${ts()}] Connected to ${host}:${port} as ${bot.username}`)
    console.log('Type chat messages or commands here (e.g. /login <password>)')
    initAfterSpawn()
  })

  // Hard reset on death to avoid stale tasks carrying over after respawn
  on('death', () => {
    try { state.lastDeathAt = Date.now(); state.lastDeathReason = 'death' } catch {}
    // Snapshot task at moment of death so we can report on respawn
    try { state.lastTaskAtDeath = state.currentTask ? { ...state.currentTask } : null } catch {}
    hardReset('death').catch(() => {})
  })

  // After respawn, notify that previous tasks were canceled due to death
  on('respawn', () => {
    const recentDeath = state?.lastDeathReason === 'death' && (Date.now() - (state.lastDeathAt || 0) < 15000)
    if (recentDeath) {
      try {
        let msg = '死了啦，都你害的啦。'
        const t = state.lastTaskAtDeath
        if (t && t.source === 'player' && t.name) msg += `（任务${t.name}取消）`
        bot.chat(msg)
      } catch {}
      try { state.lastDeathReason = null; state.lastTaskAtDeath = null } catch {}
    }
  })

  // If plugin reloads after spawn, re-initialize immediately
  if (state.hasSpawned) {
    const entityReady = bot && bot.entity && bot.entity.position
    if (entityReady) {
      dlog('Plugin loaded post-spawn; initializing features now')
      initAfterSpawn()
    } else {
      dlog('Spawn flag present but bot entity unavailable; deferring until next spawn')
      try { state.hasSpawned = false } catch {}
    }
  }

  on('end', () => {
    dlog('Bot connection closed (impl cleanup)')
    try { greetingManager?.deactivate() } catch {}
    try { watcherManager?.shutdown() } catch {}
    greetingManager = null
    try { state.hasSpawned = false } catch {}
  })

  on('kicked', (reason) => { dlog('Kicked:', reason) })

  on('error', (err) => { dlog('Error:', err) })

  return { sharedState: state }
}

function deactivate () {
  try {
    offAll()
    try { greetingManager?.deactivate() } catch {}
    try { watcherManager?.shutdown() } catch {}
    greetingManager = null
    watcherManager = null
    // Run module cleanups registered during install
    if (Array.isArray(state?.cleanups)) {
      for (const fn of state.cleanups.splice(0)) {
        try { fn() } catch {}
      }
    }
    teleportResetPromise = null
  } catch (e) {
    console.error('Error during deactivate:', e)
  }
}

module.exports = { activate, deactivate }
