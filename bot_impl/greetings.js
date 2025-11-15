const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

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
const RECENT_AI_REPLY_WINDOW_MS = 20 * 1000

function normalizeZone(zone) {
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
  } catch {
    return null
  }
}

function ensureDir(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch {}
}

class GreetingManager {
  constructor(bot, { state, on, registerCleanup, dlog }) {
    this.bot = bot
    this.state = state
    this.on = on
    this.registerCleanup = registerCleanup
    this.dlog = dlog || (() => {})
    this.cliHandler = null
  }

  install() {
    this.ensureState()
    this.initializeGreetingZones()
    this.cliHandler = ({ cmd, args }) => {
      const c = String(cmd || '').toLowerCase()
      if (c === 'greetzone') this.handleGreetZoneCli(Array.isArray(args) ? args : [])
      else if (c === 'greetlog') this.handleGreetLogCli(Array.isArray(args) ? args : [])
    }
    this.on('cli', this.cliHandler)
    this.on('playerJoined', (player) => this.handlePlayerJoin(player))
    this.on('playerLeft', (player) => this.handlePlayerLeave(player))
    this.on('end', () => this.resetOnDisconnect())
  }

  ensureState() {
    const state = this.state
    if (!state.pendingGreets || !(state.pendingGreets instanceof Map)) state.pendingGreets = new Map()
    if (!state.greetedPlayers || !(state.greetedPlayers instanceof Set)) state.greetedPlayers = new Set()
    if (!state.aiRecentReplies || !(state.aiRecentReplies instanceof Map)) state.aiRecentReplies = new Map()
    if (!Array.isArray(state.greetZones)) state.greetZones = []
    if (!Array.isArray(state.worldMemoryZones)) state.worldMemoryZones = []
  }

  initializeGreetingZones() {
    const state = this.state
    if (state.greetZonesSeeded) return
    const fromFile = this.readGreetingZonesFromFile()
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

  readGreetingZonesFromFile() {
    try {
      const text = fs.readFileSync(GREET_ZONES_FILE, 'utf8')
      const raw = JSON.parse(text)
      if (!Array.isArray(raw)) throw new Error('expected array')
      const zones = raw.map(normalizeZone).filter(Boolean)
      return zones.length ? zones : null
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.warn('[GREET] 读取配置失败:', err.message || err)
      return null
    }
  }

  writeGreetingZonesToFile(zones) {
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

  clearAllPendingGreets() {
    const state = this.state
    if (!state.pendingGreets || typeof state.pendingGreets.clear !== 'function') {
      state.pendingGreets = new Map()
      return
    }
    for (const timeout of state.pendingGreets.values()) {
      clearTimeout(timeout)
    }
    state.pendingGreets.clear()
  }

  onSpawn() {
    const state = this.state
    this.ensureState()
    this.clearAllPendingGreets()
    const nowTs = Date.now()
    for (const [name, ts] of [...state.aiRecentReplies.entries()]) {
      if (!Number.isFinite(ts) || nowTs - ts > RECENT_AI_REPLY_WINDOW_MS) state.aiRecentReplies.delete(name)
    }
    const players = this.bot && this.bot.players ? this.bot.players : {}
    state.greetedPlayers.clear()
    for (const username of Object.keys(players)) {
      if (username && username !== this.bot.username) state.greetedPlayers.add(username)
    }
    state.readyForGreeting = true
  }

  handlePlayerJoin(player) {
    const state = this.state
    if (!state || state.greetingEnabled === false) return
    const username = this.resolvePlayerUsername(player)
    if (!username) {
      this.greetLog('skip greet: unresolved username from player payload')
      return
    }
    if (username === this.bot.username) return
    if (!state.readyForGreeting) return
    if (state.greetedPlayers.has(username)) return
    if (state.pendingGreets.has(username)) return
    if (state.aiRecentReplies instanceof Map) {
      const ts = state.aiRecentReplies.get(username)
      if (Number.isFinite(ts) && Date.now() - ts < RECENT_AI_REPLY_WINDOW_MS) {
        state.greetedPlayers.add(username)
        return
      }
    }
    this.scheduleGreeting(username)
  }

  handlePlayerLeave(player) {
    const state = this.state
    if (!state || state.greetingEnabled === false) return
    const username = this.resolvePlayerUsername(player)
    if (!username) return
    state.greetedPlayers.delete(username)
    if (state.aiRecentReplies instanceof Map) state.aiRecentReplies.delete(username)
    const timeout = state.pendingGreets.get(username)
    if (timeout) {
      clearTimeout(timeout)
      state.pendingGreets.delete(username)
    }
  }

  resolvePlayerUsername(player) {
    try {
      if (!player) return null
      if (typeof player === 'string') return player
      if (player.username) return player.username
      if (player.name) return player.name
      if (player.profile && player.profile.name) return player.profile.name
      return null
    } catch {
      return null
    }
  }

  buildGreeting(username) {
    const now = new Date()
    const hour = now.getHours()
    let salutation
    if (hour >= 5 && hour < 11) salutation = '早上好呀'
    else if (hour >= 11 && hour < 14) salutation = '午好呀'
    else if (hour >= 14 && hour < 19) salutation = '下午好呀'
    else if (hour >= 19 || hour < 5) salutation = '晚上好呀'
    if (!salutation) salutation = '你好呀'
    const suffixes = this.collectGreetingSuffixes()
    const suffix = suffixes.length ? suffixes[Math.floor(Math.random() * suffixes.length)] : GREET_DEFAULT_SUFFIX
    return `${salutation} ${username}${suffix ? ` ${suffix}` : ''}`
  }

  collectGreetingSuffixes(opts = {}) {
    const state = this.state
    const staticZones = Array.isArray(state.greetZones) ? state.greetZones : []
    const memoryZones = Array.isArray(state.worldMemoryZones) ? state.worldMemoryZones : []
    const zones = staticZones.concat(memoryZones)
    if (!zones.length) return []
    const pos = this.bot?.entity?.position
    if (!pos) return []
    const currentDim = (() => {
      try {
        const raw = this.bot.game?.dimension
        return typeof raw === 'string' ? raw.toLowerCase() : null
      } catch {
        return null
      }
    })()
    const logIt = Boolean(opts.debug) || this.greetLogEnabled()
    const suffixes = []
    for (const zone of zones) {
      if (!zone || zone.enabled === false) continue
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
      const zoneDim = typeof zone.dim === 'string' ? zone.dim.toLowerCase() : null
      if (zoneDim && currentDim && zoneDim !== currentDim) {
        if (logIt) this.greetLog(`zone ${zone.name || '(unnamed)'} skipped dim mismatch zoneDim=${zoneDim} currentDim=${currentDim}`)
        continue
      }
      if (logIt) this.greetLog(`zone ${zone.name || '(unnamed)'} enabled=${zone.enabled !== false} radius=${radius} dist=${Number.isFinite(dist) ? dist.toFixed(2) : 'nan'} within=${within}`)
      if (!within) continue
      suffixes.push(suffix)
    }
    if (logIt) this.greetLog('suffix result ->', suffixes)
    return suffixes
  }

  greetLogEnabled() {
    try { return Boolean(this.state?.greetLogEnabled) } catch { return false }
  }

  greetLog(...args) {
    if (this.greetLogEnabled()) console.log('[GREET]', ...args)
  }

  scheduleGreeting(username) {
    const state = this.state
    if (!state.pendingGreets) state.pendingGreets = new Map()
    const delay = GREET_INITIAL_DELAY_MS + Math.floor(Math.random() * 2000)
    const timer = setTimeout(() => {
      try {
        state.pendingGreets.delete(username)
        if (state.greetingEnabled === false) return
        if (!state.readyForGreeting) return
        if (state.greetedPlayers.has(username)) return
        const msg = this.buildGreeting(username)
        this.bot.chat(msg)
        state.greetedPlayers.add(username)
      } catch (err) {
        this.dlog('Greeting send error', err)
      }
    }, delay)
    state.pendingGreets.set(username, timer)
  }

  handleGreetZoneCli(args = []) {
    this.initializeGreetingZones()
    const state = this.state
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
      if (!zone) {
        console.log('[GREETZONE] 参数无效，请确保名称/坐标/半径/后缀正确')
        return
      }
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
      this.initializeGreetingZones()
      console.log('[GREETZONE] 已重置到默认配置')
      return
    }
    if (sub === 'reload') {
      const zones = this.readGreetingZonesFromFile()
      if (zones && zones.length) {
        state.greetZones = zones.map(z => ({ ...z }))
        console.log('[GREETZONE] 已重新加载配置文件')
      } else {
        console.log('[GREETZONE] 配置文件不存在或内容无效，保持原状态')
      }
      return
    }
    if (sub === 'save') {
      const ok = this.writeGreetingZonesToFile(state.greetZones || [])
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

  handleGreetLogCli(args = []) {
    const state = this.state
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
        const pos = this.bot?.entity?.position
        console.log('[GREET] 调试日志状态 =', state.greetLogEnabled ? '开启' : '关闭')
        if (pos) console.log(`[GREET] 当前位置 = ${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`)
        const zones = Array.isArray(state?.greetZones) ? state.greetZones.length : 0
        console.log('[GREET] 区域配置数量 =', zones)
        break
      }
      case 'sample': {
        const suffixes = this.collectGreetingSuffixes({ debug: true })
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

  resetOnDisconnect() {
    this.clearAllPendingGreets()
    this.state.greetedPlayers?.clear()
    this.state.readyForGreeting = false
  }

  deactivate() {
    this.clearAllPendingGreets()
  }
}

function install(bot, deps) {
  const mgr = new GreetingManager(bot, deps)
  mgr.install()
  return {
    onSpawn: () => mgr.onSpawn(),
    deactivate: () => mgr.deactivate()
  }
}

module.exports = { install }
