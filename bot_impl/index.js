// Hot-reloadable bot implementation. The loader (bot.js) will call activate/deactivate

let bot = null
const { Vec3 } = require('vec3')
const logging = require('./logging')
const coreLog = logging.getLogger('core')

function dlog (...args) { coreLog.debug(...args) }
function ts () { return new Date().toISOString() }

// Shared state comes from loader to preserve across reloads
let state = null

// Listener references and timers for cleanup
const listeners = []
let fireWatcher = null
let playerWatcher = null
function initAfterSpawn() {
  // Reset greeting bookkeeping
  state.greetedPlayers.clear()
  clearAllPendingGreets()

  for (const username of Object.keys(bot.players)) {
    if (username && username !== bot.username) {
      state.greetedPlayers.add(username)
    }
  }

  state.readyForGreeting = true
  state.hasSpawned = true

  dlog('Init after spawn. Player snapshot:', Object.keys(bot.players))
  dlog('Greeted set primed with currently online players count =', state.greetedPlayers.size)

  if (fireWatcher) clearInterval(fireWatcher), (fireWatcher = null)
  fireWatcher = setInterval(() => {
    extinguishNearbyFire().catch((err) => {
      console.log('Fire watcher error:', err.message || err)
    })
  }, 1500)
  
  if (playerWatcher) clearInterval(playerWatcher), (playerWatcher = null)
  playerWatcher = setInterval(() => {
    // Suppress auto-look while pathfinding/following or when explicitly suspended
    if (state?.autoLookSuspended) return
    try { if (bot.pathfinder && bot.pathfinder.goal) return } catch {}
    const entity = bot.nearestEntity()
    if (entity !== null) {
      if (entity.type === 'player') {
        bot.lookAt(entity.position.offset(0, 1.6, 0))
      } else if (entity.type === 'mob') {
        bot.lookAt(entity.position)
      }
    }
  }, 50)
}

async function hardReset (reason) {
  try {
    // Clear shared flags that could block behaviors
    if (state) {
      state.externalBusy = false
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

async function digAt (pos) {
  const { x, y, z } = pos
  const target = bot.blockAt(new Vec3(x, y, z))
  if (!target) throw new Error(`No block at ${x},${y},${z}`)
  await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true)
  await bot.dig(target)
}

async function digUnderfoot () {
  const feet = bot.entity.position.offset(0, -1, 0)
  const target = bot.blockAt(feet)
  if (!target) throw new Error('No block underfoot')
  await bot.lookAt(feet.offset(0.5, 0.5, 0.5), true)
  await bot.dig(target)
}

async function openContainerAt (pos) {
  const { x, y, z } = pos
  const block = bot.blockAt(new Vec3(x, y, z))
  if (!block) throw new Error(`No block at ${x},${y},${z}`)
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  const container = await bot.openContainer(block)
  return container
}

async function lootAllFromContainerAt (pos) {
  const container = await openContainerAt(pos)
  try {
    for (let slot = 0; slot < container.inventoryStart; slot++) {
      const item = container.slots[slot]
      if (!item) continue
      const count = item.count
      await container.withdraw(item.type, item.metadata, count, item.nbt)
    }
  } finally {
    try { container.close() } catch {}
  }
}

function runOneShotIfPresent () {
  let mod
  try {
    // Attempt to load optional oneshot file each reload
    mod = require('./oneshot')
  } catch (e) {
    if (e && (e.code === 'MODULE_NOT_FOUND' || String(e).includes('Cannot find module'))) {
      dlog('oneshot: no file present')
      return
    }
    console.log('oneshot: load error:', e?.message || e)
    return
  }

  const fn = typeof mod === 'function' ? mod : (typeof mod?.run === 'function' ? mod.run : null)
  if (typeof fn !== 'function') {
    dlog('oneshot: module present but no function export')
    return
  }

  // Defer to next tick to ensure listeners ready
  setTimeout(async () => {
    try {
      dlog('oneshot: executing...')
      await fn(bot, { state, dlog, actions: { digAt, digUnderfoot, openContainerAt, lootAllFromContainerAt } })
      dlog('oneshot: done')
    } catch (err) {
      console.log('oneshot: error:', err?.message || err)
    }
  }, 0)
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

function clearAllPendingGreets() {
  for (const timeout of state.pendingGreets.values()) {
    clearTimeout(timeout)
  }
  state.pendingGreets.clear()
}

const GREET_INITIAL_DELAY_MS = 5000

function buildGreeting (username) {
  const now = new Date()
  const hour = now.getHours()

  let salutation
  if (hour >= 5 && hour < 11) salutation = '早上好呀'
  else if (hour >= 11 && hour < 14) salutation = '午安午安~'
  else if (hour >= 14 && hour < 18) salutation = '下午好喔'
  else if (hour >= 18 && hour < 23) salutation = '晚上好呀'
  else salutation = '深夜好喔'

  const suffix = '☆ (≧▽≦)ﾉ'
  return `${salutation} ${username}酱~ 这里是${bot.username}，${suffix}`
}

function resolvePlayerUsername (player) {
  if (!player) return null
  if (typeof player === 'string') return player
  if (player.username && typeof player.username === 'string') return player.username
  if (player.name && typeof player.name === 'string') return player.name
  if (player.profile?.name && typeof player.profile.name === 'string') return player.profile.name
  if (player.uuid && bot.players) {
    const match = Object.values(bot.players).find((entry) => entry?.uuid === player.uuid && typeof entry.username === 'string')
    if (match?.username) return match.username
  }
  if (typeof player.displayName?.toString === 'function') {
    const rendered = player.displayName.toString().trim()
    if (rendered) {
      const sanitized = rendered.replace(/\u00a7./g, '').trim()
      return sanitized || rendered
    }
  }
  if (player.entity?.username && typeof player.entity.username === 'string') return player.entity.username
  return null
}

function scheduleGreeting (username) {
  const timeout = setTimeout(() => {
    state.pendingGreets.delete(username)
    if (state.greetedPlayers.has(username)) {
      dlog('Skip greeting (race): already greeted:', username)
      return
    }
    const message = buildGreeting(username)
    dlog('Sending greeting to', username, 'message =', message)
    try { bot.chat(message) } catch (e) { console.error('Chat error:', e) }
    state.greetedPlayers.add(username)
  }, GREET_INITIAL_DELAY_MS)

  dlog(`Scheduled greeting in ${GREET_INITIAL_DELAY_MS}ms for:`, username)
  state.pendingGreets.set(username, timeout)
}

async function extinguishNearbyFire () {
  if (state.extinguishing || bot.targetDigBlock) {
    dlog('Skip fire check: busy =', { extinguishing: state.extinguishing, hasTargetDigBlock: Boolean(bot.targetDigBlock) })
    return
  }

  const fireBlock = bot.findBlock({
    matching: (block) => block && block.name === 'fire',
    maxDistance: 6
  })

  if (!fireBlock) {
    dlog('No nearby fire found')
    return
  }

  state.extinguishing = true

  try {
    await bot.lookAt(fireBlock.position.offset(0.5, 0.5, 0.5), true)
    await bot.dig(fireBlock)
    console.log(`Extinguished fire at ${fireBlock.position}`)
  } catch (err) {
    if (err?.message === 'Block is not currently diggable') return
    console.log('Failed to extinguish fire:', err.message || err)
  } finally {
    state.extinguishing = false
    dlog('Extinguish attempt complete')
  }
}

function summarizePlayer (player) {
  try {
    if (!player) return player
    const summary = {
      username: player.username ?? player.name ?? player?.profile?.name ?? null,
      name: player.name ?? null,
      uuid: player.uuid ?? null,
      hasEntity: Boolean(player.entity),
      keys: Object.keys(player || {})
    }
    return summary
  } catch (e) {
    return { error: String(e) }
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

  state = options.sharedState || {
    pendingGreets: new Map(),
    greetedPlayers: new Set(),
    readyForGreeting: false,
    extinguishing: false,
    hasSpawned: false,
    autoLookSuspended: false,
    cleanups: [],
    greetingEnabled: GREET,
    loginPassword: undefined
  }

  if (!Array.isArray(state.cleanups)) state.cleanups = []
  // Ensure greetingEnabled is initialized even when reusing shared state from loader
  if (typeof state.greetingEnabled === 'undefined') state.greetingEnabled = GREET
  // Propagate login password from loader config or env into shared state
  try {
    const cfgPwd = options?.config?.password || process.env.MC_PASSWORD
    if (cfgPwd) state.loginPassword = cfgPwd
  } catch {}
  // Bind logging to shared state so .log changes persist across reloads
  try { logging.init(state) } catch {}
  // expose shared state on bot for modules that only receive bot
  try { bot.state = state } catch {}

  // Track current external task for AI context (source: chat/cli/sense -> player/auto)
  on('external:begin', (info) => {
    try {
      const src = String(info?.source || '').toLowerCase()
      const source = (src === 'chat' || src === 'cli') ? 'player' : 'auto'
      state.currentTask = { name: String(info?.tool || info?.name || 'unknown'), source, startedAt: Date.now() }
    } catch {}
  })
  on('external:end', () => {
    try { state.currentTask = null } catch {}
  })

  function registerCleanup (fn) {
    try { if (typeof fn === 'function') state.cleanups.push(fn) } catch {}
  }

  // Event: display server messages
  on('message', (message) => {
    const rendered = typeof message.toAnsi === 'function' ? message.toAnsi() : message.toString()
    console.log(rendered)
  })

  // Feature: sleep when item dropped onto a bed at night
  try { require('./bed-sleep').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('sleep') }) } catch (e) { coreLog.warn('bed-sleep install error:', e?.message || e) }

  // Feature: follow any nearby player holding an Iron Nugget (needs pathfinder)
  try { require('./follow-iron-nugget').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('follow') }) } catch (e) { coreLog.warn('follow-iron-nugget install error:', e?.message || e) }

  // Feature: auto-eat when hungry
  try { require('./auto-eat').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('eat') }) } catch (e) { coreLog.warn('auto-eat install error:', e?.message || e) }

  // Feature: runtime log control via chat
  try { require('./log-control').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('log') }) } catch (e) { coreLog.warn('log-control install error:', e?.message || e) }

  // Feature: auto-counterattack with cute chat on getting hurt
  try { require('./auto-counter').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('pvp') }) } catch (e) { coreLog.warn('auto-counter install error:', e?.message || e) }

  // Feature: auto-equip best armor/weapon/shield from inventory
  try { require('./auto-gear').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('gear') }) } catch (e) { coreLog.warn('auto-gear install error:', e?.message || e) }
  // Feature: auto-craft iron armor if possible (requires nearby crafting table)
  try { require('./auto-armor-craft').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('autoarmor') }) } catch (e) { coreLog.warn('auto-armor-craft install error:', e?.message || e) }
  // Feature: auto-fishing when rod present and near water
  try { require('./auto-fish').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('fish') }) } catch (e) { coreLog.warn('auto-fish install error:', e?.message || e) }
  // Feature: auto-swim (float in water)
  try { require('./auto-swim').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('swim') }) } catch (e) { coreLog.warn('auto-swim install error:', e?.message || e) }

  // Feature: respond to ".bot here" with "/tpa <username>"
  try { require('./tpa-here').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('tpa') }) } catch (e) { coreLog.warn('tpa-here install error:', e?.message || e) }

  // (removed) iron-bar tree farm feature

  // Feature: AI chat (owk prefix routed to DeepSeek-compatible API)
  try { require('./ai-chat').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('ai') }) } catch (e) { coreLog.warn('ai-chat install error:', e?.message || e) }

  // Feature: world sensing -> local heuristics (no AI)
  try { require('./world-sense').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('sense') }) } catch (e) { coreLog.warn('world-sense install error:', e?.message || e) }

  // Feature: auto-plant saplings when available in inventory
  try { require('./auto-plant').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('plant') }) } catch (e) { coreLog.warn('auto-plant install error:', e?.message || e) }
  // Feature: auto-stash when inventory nearly full
  try { require('./auto-stash').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('stash') }) } catch (e) { coreLog.warn('auto-stash install error:', e?.message || e) }

  // Feature: auto-login when server prompts
  try { require('./auto-login').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('login') }) } catch (e) { coreLog.warn('auto-login install error:', e?.message || e) }

  // Feature removed: random walk (was unstable)

  // Agent: skill runner (high-level intent executor)
  try {
    const runner = require('./agent/runner').install(bot, { on, registerCleanup, log: logging.getLogger('skill') })
    // lazy register core skills (no placeholders)
    try { runner.registerSkill('go', require('./skills/go')); runner.registerSkill('gather', require('./skills/gather')); runner.registerSkill('craft', require('./skills/craft')) } catch {}
  } catch (e) { coreLog.warn('skill runner install error:', e?.message || e) }

  // Debug: drops scanner CLI
  try { require('./drops-debug').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('drops') }) } catch (e) { coreLog.warn('drops-debug install error:', e?.message || e) }
  // CLI: collect dropped items
  try { require('./collect-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('collect') }) } catch (e) { coreLog.warn('collect-cli install error:', e?.message || e) }
  // CLI: place blocks/saplings
  try { require('./place-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('place') }) } catch (e) { coreLog.warn('place-cli install error:', e?.message || e) }
  // CLI: status snapshot
  try { require('./status-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('status') }) } catch (e) { coreLog.warn('status-cli install error:', e?.message || e) }

  on('spawn', () => {
    const host = (bot._client && (bot._client.socketServerHost || bot._client.host)) || 'server'
    const port = (bot._client && bot._client.port) || ''
    console.log(`[${ts()}] Connected to ${host}:${port} as ${bot.username}`)
    console.log('Type chat messages or commands here (e.g. /login <password>)')
    initAfterSpawn()
    runOneShotIfPresent()
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
    dlog('Plugin loaded post-spawn; initializing features now')
    initAfterSpawn()
    runOneShotIfPresent()
  }

  on('playerJoined', (player) => {
    if (state && state.greetingEnabled === false) return
    dlog('playerJoined event:', summarizePlayer(player))
    const username = resolvePlayerUsername(player)
    if (!username) {
      dlog('Skip greeting: cannot resolve username from player:', player)
      return
    }
    if (username === bot.username) {
      dlog('Skip greeting: joined player is the bot itself:', username)
      return
    }
    if (!state.readyForGreeting) {
      dlog('Skip greeting: not readyForGreeting yet')
      return
    }
    if (state.greetedPlayers.has(username)) {
      dlog('Skip greeting: already greeted:', username)
      return
    }
    if (state.pendingGreets.has(username)) {
      dlog('Skip greeting: already pending:', username)
      return
    }

    scheduleGreeting(username)
  })

  on('playerLeft', (player) => {
    if (state && state.greetingEnabled === false) return
    const username = resolvePlayerUsername(player)
    dlog('playerLeft event:', summarizePlayer(player), 'resolved =', username)
    if (!username) return
    state.greetedPlayers.delete(username)
    const timeout = state.pendingGreets.get(username)
    if (timeout) {
      clearTimeout(timeout)
      state.pendingGreets.delete(username)
      dlog('Cancelled pending greeting for left player:', username)
    }
  })

  on('end', () => {
    dlog('Bot connection closed (impl cleanup)')
    if (fireWatcher) clearInterval(fireWatcher), (fireWatcher = null)
    if (playerWatcher) clearInterval(playerWatcher), (playerWatcher = null)
    clearAllPendingGreets()
    state.greetedPlayers.clear()
    state.readyForGreeting = false
  })

  on('kicked', (reason) => { dlog('Kicked:', reason) })

  on('error', (err) => { dlog('Error:', err) })

  return { sharedState: state }
}

function deactivate () {
  try {
    offAll()
    if (fireWatcher) clearInterval(fireWatcher), (fireWatcher = null)
    if (playerWatcher) clearInterval(playerWatcher), (playerWatcher = null)
    clearAllPendingGreets()
    // Run module cleanups registered during install
    if (Array.isArray(state?.cleanups)) {
      for (const fn of state.cleanups.splice(0)) {
        try { fn() } catch {}
      }
    }
  } catch (e) {
    console.error('Error during deactivate:', e)
  }
}

module.exports = { activate, deactivate }
