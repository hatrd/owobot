let createContextBus
try { ({ createContextBus } = require('./ai-chat/context-bus')) } catch {}
const { getListedPlayerEntries, hasListedSelf } = require('./tablist-utils')

class WatcherManager {
  constructor(bot, { state, on, registerCleanup, dlog }) {
    this.bot = bot
    this.state = state
    this.on = on
    this.registerCleanup = registerCleanup
    this.dlog = dlog || (() => {})
    this.contextBus = createContextBus ? createContextBus({ state }) : null
    this.fireTimer = null
    this.idleTimer = null
    this.tabHealthTimer = null
    this.explosionCleanup = null
    this.lastFireReconnectAt = 0
    this.lastTabReconnectAt = 0
    this.tabEmptyStreak = 0
    this.lastSpawnAt = 0
    this.LOOK_GREET_COOLDOWN_MS = 10 * 60 * 1000
    this.TAB_HEALTH_INTERVAL_MS = 1500
    this.TAB_HEALTH_SPAWN_GRACE_MS = 12000
    this.TAB_EMPTY_STREAK_THRESHOLD = 3
    this.TAB_RECONNECT_COOLDOWN_MS = 12000
  }

  normalizeUsername (name) {
    return String(name || '').replace(/\u00a7./g, '').trim().toLowerCase()
  }

  onSpawn() {
    this.stopTimers()
    this.lastSpawnAt = Date.now()
    this.tabEmptyStreak = 0
    this.fireTimer = setInterval(() => {
      this.extinguishNearbyFire().catch((err) => this.handleFireWatcherError(err))
    }, 1500)
    this.idleTimer = setInterval(() => this.trackNearbyEntity(), 120)
    this.tabHealthTimer = setInterval(() => this.checkTabListHealth(), this.TAB_HEALTH_INTERVAL_MS)
    this.registerExplosionGuard()
    this.pruneLookGreetHistory()
  }

  stopTimers() {
    if (this.fireTimer) { clearInterval(this.fireTimer); this.fireTimer = null }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null }
    if (this.tabHealthTimer) { clearInterval(this.tabHealthTimer); this.tabHealthTimer = null }
  }

  handleFireWatcherError (err) {
    const message = err?.message || err
    try { console.log('Fire watcher error:', message) } catch {}
    const msgText = typeof message === 'string' ? message : ''
    if (!msgText || !/position/i.test(msgText)) return
    const now = Date.now()
    if (now - this.lastFireReconnectAt < 5000) return
    this.lastFireReconnectAt = now
    try {
      console.log(`[${new Date().toISOString()}] Fire watcher forcing reconnect due to invalid bot state`)
    } catch {}
    this.forceReconnect('fire watcher invalid state')
  }

  forceReconnect (reason) {
    try {
      if (typeof this.bot.quit === 'function') {
        this.bot.quit(reason)
        return
      }
      if (typeof this.bot.end === 'function') {
        this.bot.end(reason)
        return
      }
      if (this.bot._client && typeof this.bot._client.end === 'function') {
        this.bot._client.end(reason)
      }
    } catch (e) {
      try { console.log('Failed to terminate bot after fire watcher error:', e?.message || e) } catch {}
    }
  }

  checkTabListHealth () {
    try {
      const now = Date.now()
      if (!this.lastSpawnAt || (now - this.lastSpawnAt) < this.TAB_HEALTH_SPAWN_GRACE_MS) return
      const entries = getListedPlayerEntries(this.bot)
      if (entries.length > 0) {
        this.tabEmptyStreak = 0
        return
      }
      if (!hasListedSelf(this.bot, entries)) this.tabEmptyStreak++
      if (this.tabEmptyStreak < this.TAB_EMPTY_STREAK_THRESHOLD) return
      if (now - this.lastTabReconnectAt < this.TAB_RECONNECT_COOLDOWN_MS) return
      this.lastTabReconnectAt = now
      this.tabEmptyStreak = 0
      try {
        console.log(`[${new Date().toISOString()}] Tablist empty for ${this.TAB_EMPTY_STREAK_THRESHOLD} checks; forcing reconnect`)
      } catch {}
      this.forceReconnect('tablist empty')
    } catch {}
  }

  registerExplosionGuard() {
    if (this.explosionCleanup) return
    let lastExplosionAt = 0
    const handler = (pos, strength) => {
      const now = Date.now()
      if (now - lastExplosionAt < 200) return
      lastExplosionAt = now
      try { this.dlog('Explosion near', pos ? `${pos.x},${pos.y},${pos.z}` : 'unknown', 'strength=', strength) } catch {}
      const until = now + 1500
      this.state.explosionCooldownUntil = until
      try { if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null) } catch {}
      try { if (typeof this.bot.stopDigging === 'function') this.bot.stopDigging() } catch {}
      try { this.bot.clearControlStates() } catch {}
    }
    this.on('explosion', handler)
    this.explosionCleanup = () => {
      try { this.bot.off('explosion', handler) } catch {}
      this.explosionCleanup = null
    }
    if (typeof this.registerCleanup === 'function') {
      this.registerCleanup(() => this.explosionCleanup && this.explosionCleanup())
    }
  }

  async extinguishNearbyFire () {
    if (this.state.extinguishing || this.bot.targetDigBlock) {
      this.dlog('Skip fire check: busy =', { extinguishing: this.state.extinguishing, hasTargetDigBlock: Boolean(this.bot.targetDigBlock) })
      return
    }

    const fireBlock = this.bot.findBlock({
      matching: (block) => block && block.name === 'fire',
      maxDistance: 6
    })

    if (!fireBlock) {
      this.dlog('No nearby fire found')
      return
    }

    this.state.extinguishing = true

    try {
      await this.bot.lookAt(fireBlock.position.offset(0.5, 0.5, 0.5), true)
      await this.bot.dig(fireBlock)
      const posText = String(fireBlock.position)
      console.log(`Extinguished fire at ${posText}`)
      try { if (this.contextBus) this.contextBus.pushEvent('fire.extinguish', posText) } catch {}
    } catch (err) {
      if (err?.message === 'Block is not currently diggable') return
      console.log('Failed to extinguish fire:', err.message || err)
    } finally {
      this.state.extinguishing = false
      this.dlog('Extinguish attempt complete')
    }
  }

  trackNearbyEntity () {
    try {
      const hasGoal = !!(this.bot.pathfinder && this.bot.pathfinder.goal)
      const hasTask = !!(this.state?.currentTask)
      const runnerBusy = !!(this.bot._skillRunnerState && this.bot._skillRunnerState.tasks && this.bot._skillRunnerState.tasks.size > 0)
      const busy = this.state?.externalBusy || this.state?.holdItemLock || this.state?.autoLookSuspended || hasGoal || hasTask || runnerBusy || this.bot.currentWindow || this.bot.targetDigBlock
      if (busy) return
    } catch {}
    const entity = this.bot.nearestEntity()
    if (!entity) return
    try {
      const name = String(entity.name || entity.displayName || '').toLowerCase()
      if (entity.type === 'player') {
        this.bot.lookAt(entity.position.offset(0, 1.6, 0))
        this.maybeGreetLookTarget(entity)
      } else if (entity.type === 'mob' && name !== 'enderman') {
        this.bot.lookAt(entity.position)
      }
    } catch {}
  }

  ensureLookGreetState () {
    if (!this.state.autoLookGreet || typeof this.state.autoLookGreet !== 'object') this.state.autoLookGreet = {}
    const slice = this.state.autoLookGreet
    if (!(slice.cooldowns instanceof Map)) slice.cooldowns = new Map()
    if (!(slice.inFlight instanceof Set)) slice.inFlight = new Set()
    if (!(slice.lastEmit instanceof Map)) slice.lastEmit = new Map()
    return slice
  }

  pruneLookGreetHistory () {
    const slice = this.ensureLookGreetState()
    const now = Date.now()
    for (const [name, ts] of [...slice.cooldowns.entries()]) {
      if (!Number.isFinite(ts) || now - ts > this.LOOK_GREET_COOLDOWN_MS) slice.cooldowns.delete(name)
    }
  }

  maybeGreetLookTarget (entity) {
    try {
      const slice = this.ensureLookGreetState()
      const rawName = String(entity.username || entity.name || '').trim()
      const usernameKey = this.normalizeUsername(rawName)
      if (!usernameKey) return
      const selfKey = this.normalizeUsername(this.bot.username || '')
      if (selfKey && usernameKey === selfKey) return
      const now = Date.now()
      if (slice.inFlight.has(usernameKey)) return
      const last = slice.cooldowns.get(usernameKey)
      if (Number.isFinite(last) && (now - last) < this.LOOK_GREET_COOLDOWN_MS) return
      const lastEmit = slice.lastEmit.get(usernameKey)
      if (Number.isFinite(lastEmit) && (now - lastEmit) < 2000) return
      slice.lastEmit.set(usernameKey, now)
      const payload = {
        username: rawName || entity.username || entity.name || '',
        key: usernameKey,
        entityId: entity.id,
        reason: 'auto-look',
        position: entity.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null
      }
      try { this.bot.emit('auto-look:greet', payload) } catch {}
    } catch {}
  }

  shutdown () {
    this.stopTimers()
    if (this.explosionCleanup) {
      this.explosionCleanup()
      this.explosionCleanup = null
    }
  }
}

function install(bot, deps) {
  const mgr = new WatcherManager(bot, deps)
  return {
    onSpawn: () => mgr.onSpawn(),
    shutdown: () => mgr.shutdown()
  }
}

module.exports = { install }
