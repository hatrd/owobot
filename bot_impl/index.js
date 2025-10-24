// Hot-reloadable bot implementation. The loader (bot.js) will call activate/deactivate

let bot = null
const fs = require('fs')
const path = require('path')
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
let explosionCooldownUntil = 0
const RECENT_AI_REPLY_WINDOW_MS = 20 * 1000
function initAfterSpawn() {
  // Reset greeting bookkeeping
  if (!state?.greetedPlayers || typeof state.greetedPlayers.clear !== 'function') {
    state.greetedPlayers = new Set()
  }
  state.greetedPlayers.clear()
  if (!state?.pendingGreets || !(state.pendingGreets instanceof Map)) state.pendingGreets = new Map()
  clearAllPendingGreets()
  if (!state?.aiRecentReplies || !(state.aiRecentReplies instanceof Map)) state.aiRecentReplies = new Map()
  const nowTs = Date.now()
  for (const [name, ts] of [...state.aiRecentReplies.entries()]) {
    if (!Number.isFinite(ts) || nowTs - ts > RECENT_AI_REPLY_WINDOW_MS) state.aiRecentReplies.delete(name)
  }

  const players = bot && bot.players ? bot.players : {}
  for (const username of Object.keys(players)) {
    if (username && username !== bot.username) {
      state.greetedPlayers.add(username)
    }
  }

  state.readyForGreeting = true
  state.hasSpawned = true

  dlog('Init after spawn. Player snapshot:', Object.keys(players))
  dlog('Greeted set primed with currently online players count =', state.greetedPlayers.size)

  if (fireWatcher) clearInterval(fireWatcher), (fireWatcher = null)
  fireWatcher = setInterval(() => {
    extinguishNearbyFire().catch((err) => {
      console.log('Fire watcher error:', err.message || err)
    })
  }, 1500)
  
  if (playerWatcher) clearInterval(playerWatcher), (playerWatcher = null)
  playerWatcher = setInterval(() => {
    // Only run when completely idle: no tasks, no locks, no goals
    try {
      const hasGoal = !!(bot.pathfinder && bot.pathfinder.goal)
      const hasTask = !!(state?.currentTask)
      const runnerBusy = !!(bot._skillRunnerState && bot._skillRunnerState.tasks && bot._skillRunnerState.tasks.size > 0)
      const busy = state?.externalBusy || state?.holdItemLock || state?.autoLookSuspended || hasGoal || hasTask || runnerBusy || bot.currentWindow || bot.targetDigBlock
      if (busy) return
    } catch {}
    const entity = bot.nearestEntity()
    if (entity) {
      try {
        if (entity.type === 'player') bot.lookAt(entity.position.offset(0, 1.6, 0))
        else if (entity.type === 'mob') bot.lookAt(entity.position)
      } catch {}
    }
  }, 120)

  // Guard: explosion storms may thrash physics/pathfinder and trigger disconnects on some servers.
  // On explosion, briefly clear goals and controls, and pause automations to let chunks/physics settle.
  try {
    let lastExplosionAt = 0
    const onExplosion = (pos, strength, affected, source) => {
      const now = Date.now()
      // Coalesce bursts
      if (now - lastExplosionAt < 200) return
      lastExplosionAt = now
      try { coreLog.warn('Explosion near', pos ? `${pos.x},${pos.y},${pos.z}` : 'unknown', 'strength=', strength) } catch {}
      explosionCooldownUntil = now + 1500
      try { if (state) state.explosionCooldownUntil = explosionCooldownUntil } catch {}
      try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
      try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch {}
      try { bot.clearControlStates() } catch {}
    }
    on('explosion', onExplosion)
  } catch {}
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
  if (!state?.pendingGreets || typeof state.pendingGreets.clear !== 'function') {
    state.pendingGreets = new Map()
    return
  }
  for (const timeout of state.pendingGreets.values()) {
    clearTimeout(timeout)
  }
  state.pendingGreets.clear()
}

const GREET_INITIAL_DELAY_MS = 5000
const GREET_DEFAULT_SUFFIX = '☆ (≧▽≦)ﾉ'
const GREET_ZONES_FILE = process.env.GREET_ZONES_FILE || path.join(__dirname, '..', 'data', 'greet-zones.json')
const DEFAULT_GREETING_ZONES = [
  {
    name: 'siwuxie_wool',
    x: -175,
    y: 64,
    z: 99,
    radius: 50,
    suffix: 'Siwuxie_log 的十六色羊毛机已经开机啦，现在 tpa 我免费领羊毛~',
    enabled: true
  }
]

function greetLogEnabled () { try { return Boolean(state?.greetLogEnabled) } catch { return false } }
function greetLog (...args) { if (greetLogEnabled()) console.log('[GREET]', ...args) }

function normalizeZone (zone) {
  try {
    if (!zone) return null
    const name = String(zone.name || '').trim()
    if (!name) return null
    const sx = zone.x ?? zone.cx ?? zone.pos?.x
    const sy = zone.y ?? zone.cy ?? zone.pos?.y
    const sz = zone.z ?? zone.cz ?? zone.pos?.z
    const radius = Number(zone.radius ?? zone.r)
    const suffix = String(zone.suffix || '').trim()
    if (![sx, sy, sz].every(v => Number.isFinite(Number(v)))) return null
    if (!Number.isFinite(radius) || radius <= 0) return null
    if (!suffix) return null
    return {
      name,
      x: Number(sx),
      y: Number(sy),
      z: Number(sz),
      radius,
      suffix,
      enabled: zone.enabled === false ? false : true
    }
  } catch { return null }
}

function readGreetingZonesFromFile () {
  try {
    const text = fs.readFileSync(GREET_ZONES_FILE, 'utf8')
    const raw = JSON.parse(text)
    if (!Array.isArray(raw)) throw new Error('expected array')
    const zones = raw.map(normalizeZone).filter(Boolean)
    return zones.length ? zones : null
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[GREET] 读取配置失败:', err.message || err)
    }
    return null
  }
}

function ensureDir (file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch {}
}

function writeGreetingZonesToFile (zones) {
  try {
    const data = Array.isArray(zones) ? zones.map(normalizeZone).filter(Boolean) : []
    ensureDir(GREET_ZONES_FILE)
    fs.writeFileSync(GREET_ZONES_FILE, JSON.stringify(data, null, 2), 'utf8')
    console.log('[GREET] 已写入配置:', GREET_ZONES_FILE)
    return true
  } catch (err) {
    console.warn('[GREET] 写入配置失败:', err.message || err)
    return false
  }
}

function initializeGreetingZones () {
  if (!state) return
  if (!Array.isArray(state.greetZones)) state.greetZones = []
  if (typeof state.greetZonesSeeded !== 'boolean') state.greetZonesSeeded = false
  if (state.greetZonesSeeded) return
  const fromFile = readGreetingZonesFromFile()
  if (fromFile && fromFile.length) {
    state.greetZones = fromFile.map(z => ({ ...z }))
    console.log('[GREET] 已加载外部问候区配置:', GREET_ZONES_FILE)
  } else if (!state.greetZones.length) {
    for (const zone of DEFAULT_GREETING_ZONES) {
      const norm = normalizeZone(zone)
      if (norm) state.greetZones.push(norm)
    }
  }
  state.greetZonesSeeded = true
}

function collectGreetingSuffixes (opts = {}) {
  try {
    if (!state || !Array.isArray(state.greetZones)) return []
    const pos = bot?.entity?.position
    if (!pos) return []
    const logIt = Boolean(opts.debug) || greetLogEnabled()
    const suffixes = []
    for (const zone of state.greetZones) {
      if (!zone) continue
      if (zone.enabled === false) continue
      const suffix = typeof zone.suffix === 'string' ? zone.suffix.trim() : ''
      if (!suffix) continue
      const radius = Number(zone.radius)
      if (!Number.isFinite(radius) || radius <= 0) continue
      const zx = Number(zone.x ?? zone.cx ?? zone.pos?.x)
      const zy = Number(zone.y ?? zone.cy ?? zone.pos?.y)
      const zz = Number(zone.z ?? zone.cz ?? zone.pos?.z)
      if (![zx, zy, zz].every(Number.isFinite)) continue
      const center = new Vec3(zx, zy, zz)
      const dist = pos.distanceTo(center)
      const within = Number.isFinite(dist) && dist <= radius
      if (logIt) greetLog(`zone ${zone.name || '(unnamed)'} enabled=${zone.enabled !== false} radius=${radius} dist=${Number.isFinite(dist) ? dist.toFixed(2) : 'nan'} within=${within}`)
      if (!within) continue
      suffixes.push(suffix)
    }
    if (logIt) greetLog('suffix result ->', suffixes)
    return suffixes
  } catch { return [] }
}

function handleGreetZoneCli (args = []) {
  initializeGreetingZones()
  const sub = String(args[0] || '').toLowerCase()
  if (!sub || sub === 'list' || sub === 'ls') {
    const zones = Array.isArray(state?.greetZones) ? state.greetZones : []
    console.log(`[GREETZONE] 共${zones.length}个配置`)
    zones.forEach((zone, idx) => {
      try {
        console.log(`[${idx}] ${zone.name || '未命名'} @ (${zone.x},${zone.y},${zone.z}) r=${zone.radius} enabled=${zone.enabled !== false} suffix="${zone.suffix || ''}"`)
      } catch {}
    })
    if (!zones.length) console.log('[GREETZONE] 使用 .greetzone add <name> <x> <y> <z> <radius> <suffix...> 添加')
    return
  }

  if (sub === 'add' || sub === 'set') {
    if (args.length < 6) {
      console.log('[GREETZONE] 用法: .greetzone add <名称> <x> <y> <z> <半径> <后缀...>')
      return
    }
    const name = String(args[1] || '').trim()
    const payload = {
      name,
      x: Number(args[2]),
      y: Number(args[3]),
      z: Number(args[4]),
      radius: Number(args[5]),
      suffix: args.slice(6).join(' ').trim(),
      enabled: true
    }
    const zone = normalizeZone(payload)
    if (!zone) { console.log('[GREETZONE] 参数无效，请确保名称/坐标/半径/后缀正确'); return }
    const zones = state.greetZones
    const idx = zones.findIndex((z) => String(z?.name || '').toLowerCase() === name.toLowerCase())
    if (idx >= 0) zones[idx] = zone
    else zones.push(zone)
    console.log(`[GREETZONE] ${idx >= 0 ? '更新' : '添加'} ${name}`)
    return
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'del' || sub === 'delete') {
    const name = String(args[1] || '').trim()
    if (!name) { console.log('[GREETZONE] 用法: .greetzone remove <名称>'); return }
    const zones = state.greetZones
    const idx = zones.findIndex((z) => String(z?.name || '').toLowerCase() === name.toLowerCase())
    if (idx < 0) { console.log(`[GREETZONE] 未找到 ${name}`); return }
    zones.splice(idx, 1)
    console.log(`[GREETZONE] 已移除 ${name}`)
    return
  }

  if (sub === 'enable' || sub === 'on') {
    const name = String(args[1] || '').trim()
    if (!name) { console.log('[GREETZONE] 用法: .greetzone enable <名称>'); return }
    const zone = state.greetZones.find((z) => String(z?.name || '').toLowerCase() === name.toLowerCase())
    if (!zone) { console.log(`[GREETZONE] 未找到 ${name}`); return }
    zone.enabled = true
    console.log(`[GREETZONE] 已启用 ${name}`)
    return
  }

  if (sub === 'disable' || sub === 'off') {
    const name = String(args[1] || '').trim()
    if (!name) { console.log('[GREETZONE] 用法: .greetzone disable <名称>'); return }
    const zone = state.greetZones.find((z) => String(z?.name || '').toLowerCase() === name.toLowerCase())
    if (!zone) { console.log(`[GREETZONE] 未找到 ${name}`); return }
    zone.enabled = false
    console.log(`[GREETZONE] 已禁用 ${name}`)
    return
  }

  if (sub === 'clear') {
    state.greetZones.splice(0, state.greetZones.length)
    console.log('[GREETZONE] 已清空所有配置（不会自动恢复默认）')
    return
  }

  if (sub === 'reset') {
    state.greetZones.splice(0, state.greetZones.length)
    state.greetZonesSeeded = false
    initializeGreetingZones()
    console.log('[GREETZONE] 已重置到默认配置')
    return
  }

  if (sub === 'reload') {
    const zones = readGreetingZonesFromFile()
    if (zones && zones.length) {
      state.greetZones = zones.map(z => ({ ...z }))
      console.log('[GREETZONE] 已重新加载配置文件')
    } else {
      console.log('[GREETZONE] 配置文件不存在或内容无效，保持原状态')
    }
    return
  }

  if (sub === 'save') {
    const ok = writeGreetingZonesToFile(state.greetZones || [])
    if (!ok) console.log('[GREETZONE] 保存失败（查看日志）')
    return
  }

  if (sub === 'file') {
    console.log('[GREETZONE] 配置文件路径 =', GREET_ZONES_FILE)
    return
  }

  if (sub === 'help') {
    console.log('[GREETZONE] 指令: list|add|remove|enable|disable|clear|reset|reload|save|file')
    console.log('  add 示例: .greetzone add sheep -175 64 10 40 来领取羊毛呀')
    return
  }

  console.log('[GREETZONE] 未知子命令，使用 .greetzone help 查看用法')
}

function handleGreetLogCli (args = []) {
  const sub = String(args[0] || 'status').toLowerCase()
  switch (sub) {
    case 'on':
    case 'enable':
      state.greetLogEnabled = true
      console.log('[GREET] 调试日志已开启')
      break
    case 'off':
    case 'disable':
      state.greetLogEnabled = false
      console.log('[GREET] 调试日志已关闭')
      break
    case 'status': {
      const pos = bot?.entity?.position
      console.log('[GREET] 调试日志状态 =', state.greetLogEnabled ? '开启' : '关闭')
      if (pos) console.log(`[GREET] 当前位置 = ${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`)
      const zones = Array.isArray(state?.greetZones) ? state.greetZones.length : 0
      console.log('[GREET] 区域配置数量 =', zones)
      break
    }
    case 'sample': {
      const suffixes = collectGreetingSuffixes({ debug: true })
      console.log('[GREET] 即时匹配后缀 =', suffixes.length ? suffixes.join(' | ') : '无')
      break
    }
    case 'help':
      console.log('[GREET] 用法: .greetlog on|off|status|sample')
      console.log('  sample 会立即计算一次并打印详情')
      break
    default:
      console.log('[GREET] 未知子命令，使用 .greetlog help 查看用法')
  }
}

function buildGreeting (username) {
  const now = new Date()
  const hour = now.getHours()

  let salutation
  if (hour >= 5 && hour < 11) salutation = '早上好呀'
  else if (hour >= 11 && hour < 14) salutation = '午安午安~'
  else if (hour >= 14 && hour < 18) salutation = '下午好喔'
  else if (hour >= 18 && hour < 23) salutation = '晚上好呀'
  else salutation = '深夜好喔'

  const suffixes = collectGreetingSuffixes()
  greetLog('build greeting for', username, 'suffixes=', suffixes)
  const parts = [GREET_DEFAULT_SUFFIX, ...suffixes]
  const extra = parts.length ? `，${parts.join(' ')}` : ''
  return `${salutation} ${username}酱~ 这里是${bot.username}${extra}`
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
  greetLog('queue greeting for', username, 'in', `${GREET_INITIAL_DELAY_MS}ms`)
  const timeout = setTimeout(() => {
    state.pendingGreets.delete(username)
    if (state.greetedPlayers.has(username)) {
      greetLog('skip greet (already greeted at dispatch)', username)
      dlog('Skip greeting (race): already greeted:', username)
      return
    }
    const message = buildGreeting(username)
    greetLog('send greeting', username, 'message=', message)
    dlog('Sending greeting to', username, 'message =', message)
    try { bot.chat(message) } catch (e) { console.error('Chat error:', e) }
    state.greetedPlayers.add(username)
  }, GREET_INITIAL_DELAY_MS)

  greetLog('scheduled greeting', username)
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
    greetZones: [],
    greetZonesSeeded: false,
    greetLogEnabled: false,
    loginPassword: undefined
  }

  if (!Array.isArray(state.cleanups)) state.cleanups = []
  if (!Number.isFinite(state.externalBusyCount) || state.externalBusyCount < 0) state.externalBusyCount = 0
  if (!Array.isArray(state.greetZones)) state.greetZones = []
  if (typeof state.greetZonesSeeded !== 'boolean') state.greetZonesSeeded = false
  if (typeof state.greetLogEnabled !== 'boolean') state.greetLogEnabled = false
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

  initializeGreetingZones()

  if (Array.isArray(state.greetZones)) {
    writeGreetingZonesToFile(state.greetZones)
  }

  // Optional: dig packet trace/throttle for diagnosing anti-cheat timing
  try { require('./dig-throttle').install(bot, { log: logging.getLogger('dig') }) } catch (e) { coreLog.warn('dig-throttle install error:', e?.message || e) }

  // Track current external task for AI context (source: chat/cli/sense -> player/auto)
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

  function registerCleanup (fn) {
    try { if (typeof fn === 'function') state.cleanups.push(fn) } catch {}
  }

  // Event: display server messages
  on('message', (message) => {
    try {
      const rendered = typeof message.toAnsi === 'function' ? message.toAnsi() : String(message)
      const max = 800
      const out = rendered.length > max ? (rendered.slice(0, max - 1) + '…') : rendered
      console.log(out)
    } catch (e) {
      try { console.log(String(message)) } catch {}
    }
  })

  on('cli', ({ cmd, args }) => {
    const c = String(cmd || '').toLowerCase()
    if (c === 'greetzone') {
      handleGreetZoneCli(Array.isArray(args) ? args : [])
    } else if (c === 'greetlog') {
      handleGreetLogCli(Array.isArray(args) ? args : [])
    }
  })

  // Feature: sleep when item dropped onto a bed at night
  try { require('./bed-sleep').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('sleep') }) } catch (e) { coreLog.warn('bed-sleep install error:', e?.message || e) }

  // Feature: follow any nearby player holding an Iron Nugget (needs pathfinder)
  try { require('./follow-iron-nugget').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('follow') }) } catch (e) { coreLog.warn('follow-iron-nugget install error:', e?.message || e) }

  // Feature: auto-eat when hungry
  try { require('./auto-eat').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('eat') }) } catch (e) { coreLog.warn('auto-eat install error:', e?.message || e) }
  // Feature: auto-back and pickup on death prompt
  try { require('./auto-back').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('back') }) } catch (e) { coreLog.warn('auto-back install error:', e?.message || e) }

  // Feature: runtime log control via chat
  try { require('./log-control').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('log') }) } catch (e) { coreLog.warn('log-control install error:', e?.message || e) }

  // Feature: automated log analysis + iteration
  try { require('./auto-iterate').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('iterate') }) } catch (e) { coreLog.warn('auto-iterate install error:', e?.message || e) }

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
  // Fun: follow jukebox music and bob head
  try { require('./jukebox-fan').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('jukebox') }) } catch (e) { coreLog.warn('jukebox-fan install error:', e?.message || e) }

  // Feature: respond to ".bot here" with "/tpa <username>"
  try { require('./tpa-here').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('tpa') }) } catch (e) { coreLog.warn('tpa-here install error:', e?.message || e) }

  // (removed) iron-bar tree farm feature

  // Feature: AI chat (owk prefix routed to DeepSeek-compatible API)
  try { require('./ai-chat').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('ai') }) } catch (e) { coreLog.warn('ai-chat install error:', e?.message || e) }

  // Feature: world sensing -> local heuristics (no AI)
  try { require('./world-sense').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('sense') }) } catch (e) { coreLog.warn('world-sense install error:', e?.message || e) }

  // Feature: auto-plant saplings when available in inventory
  try { require('./auto-plant').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('plant') }) } catch (e) { coreLog.warn('auto-plant install error:', e?.message || e) }
  // Feature: auto-stash when inventory nearly full (default disabled; intended for fishing)
  try { require('./auto-stash').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('stash') }) } catch (e) { coreLog.warn('auto-stash install error:', e?.message || e) }

  // Feature: inventory compression when space is tight (no tossing)
  try { require('./inventory-compress').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('compress') }) } catch (e) { coreLog.warn('inventory-compress install error:', e?.message || e) }

  // Feature: frame-based storage sorting tools
  try { require('./frame-sorter').install(bot, { on, state, log: logging.getLogger('frames') }) } catch (e) { coreLog.warn('frame-sorter install error:', e?.message || e) }

  // Feature: auto-login when server prompts
  try { require('./auto-login').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('login') }) } catch (e) { coreLog.warn('auto-login install error:', e?.message || e) }

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
      runner.registerSkill('write_text', require('./skills/write-text'))
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
  try { require('./drops-debug').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('drops') }) } catch (e) { coreLog.warn('drops-debug install error:', e?.message || e) }
  // CLI: collect dropped items
  try { require('./collect-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('collect') }) } catch (e) { coreLog.warn('collect-cli install error:', e?.message || e) }
  // CLI: place blocks/saplings
  try { require('./place-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('place') }) } catch (e) { coreLog.warn('place-cli install error:', e?.message || e) }
  try { require('./spawnproof-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('spawnproof') }) } catch (e) { coreLog.warn('spawnproof-cli install error:', e?.message || e) }
  // CLI: status snapshot
  try { require('./status-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('status') }) } catch (e) { coreLog.warn('status-cli install error:', e?.message || e) }
  // CLI: start/stop mining ores
  try { require('./mine-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('mine') }) } catch (e) { coreLog.warn('mine-cli install error:', e?.message || e) }
  // CLI: debug helpers (.entities/.animals/.cows/.pos/.inv/.goal/.task/.tools/.hawk/.sense)
  try { require('./debug-cli').install(bot, { on, dlog, state, registerCleanup, log: logging.getLogger('dbg') }) } catch (e) { coreLog.warn('debug-cli install error:', e?.message || e) }

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
      greetLog('skip greet: unresolved username from player payload')
      dlog('Skip greeting: cannot resolve username from player:', player)
      return
    }
    greetLog('player joined', username, 'pos=', (() => { try { const p = player?.entity?.position; return p ? `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` : 'unknown' } catch { return 'unknown' } })())
    if (username === bot.username) {
      greetLog('skip greet: joined player is bot itself', username)
      dlog('Skip greeting: joined player is the bot itself:', username)
      return
    }
    if (!state.readyForGreeting) {
      greetLog('skip greet: bot not ready (readyForGreeting=false)', username)
      dlog('Skip greeting: not readyForGreeting yet')
      return
    }
    if (state.greetedPlayers.has(username)) {
      greetLog('skip greet: already greeted', username)
      dlog('Skip greeting: already greeted:', username)
      return
    }
    if (state.pendingGreets.has(username)) {
      greetLog('skip greet: already pending', username)
      dlog('Skip greeting: already pending:', username)
      return
    }
    if (state.aiRecentReplies instanceof Map) {
      const ts = state.aiRecentReplies.get(username)
      if (Number.isFinite(ts) && Date.now() - ts < RECENT_AI_REPLY_WINDOW_MS) {
        greetLog('skip greet: recent AI reply exists', username)
        dlog('Skip greeting: recent AI reply for', username)
        state.greetedPlayers.add(username)
        return
      }
    }

    scheduleGreeting(username)
  })

  on('playerLeft', (player) => {
    if (state && state.greetingEnabled === false) return
    const username = resolvePlayerUsername(player)
    dlog('playerLeft event:', summarizePlayer(player), 'resolved =', username)
    if (!username) {
      greetLog('player left but username unresolved (no cleanup)')
      return
    }
    greetLog('player left', username)
    state.greetedPlayers.delete(username)
    if (state.aiRecentReplies instanceof Map) state.aiRecentReplies.delete(username)
    const timeout = state.pendingGreets.get(username)
    if (timeout) {
      clearTimeout(timeout)
      state.pendingGreets.delete(username)
      greetLog('cancel pending greeting due to leave', username)
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
