// Hot-reloadable bot implementation. The loader (bot.js) will call activate/deactivate

let bot = null
let DEBUG = true

function dlog (...args) {
  if (DEBUG) console.log('[DEBUG]', ...args)
}

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

const GREET_INITIAL_DELAY_MS = 3000

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
  DEBUG = (() => {
    const v = String(process.env.MC_DEBUG ?? '1').toLowerCase()
    return !(v === '0' || v === 'false' || v === 'no' || v === 'off')
  })()

  state = options.sharedState || {
    pendingGreets: new Map(),
    greetedPlayers: new Set(),
    readyForGreeting: false,
    extinguishing: false,
    hasSpawned: false
  }

  // Event: display server messages
  on('message', (message) => {
    const rendered = typeof message.toAnsi === 'function' ? message.toAnsi() : message.toString()
    console.log(rendered)
  })

  on('spawn', () => {
    console.log(`Connected to ${bot._client.socketServerHost || bot._client.socketServerHost || 'server'}:${bot._client.port || ''} as ${bot.username}`)
    console.log('Type chat messages or commands here (e.g. /login <password>)')
    initAfterSpawn()
  })

  // If plugin reloads after spawn, re-initialize immediately
  if (state.hasSpawned) {
    dlog('Plugin loaded post-spawn; initializing features now')
    initAfterSpawn()
  }

  on('playerJoined', (player) => {
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
    console.log('Bot connection closed')
    if (fireWatcher) clearInterval(fireWatcher), (fireWatcher = null)
    clearAllPendingGreets()
    state.greetedPlayers.clear()
    state.readyForGreeting = false
  })

  on('kicked', (reason) => {
    console.log('Kicked:', reason)
  })

  on('error', (err) => {
    console.error('Error:', err)
  })

  return { sharedState: state }
}

function deactivate () {
  try {
    offAll()
    if (fireWatcher) clearInterval(fireWatcher), (fireWatcher = null)
    clearAllPendingGreets()
  } catch (e) {
    console.error('Error during deactivate:', e)
  }
}

module.exports = { activate, deactivate }
