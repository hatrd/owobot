class WatcherManager {
  constructor(bot, { state, on, registerCleanup, dlog }) {
    this.bot = bot
    this.state = state
    this.on = on
    this.registerCleanup = registerCleanup
    this.dlog = dlog || (() => {})
    this.fireTimer = null
    this.idleTimer = null
    this.explosionCleanup = null
  }

  onSpawn() {
    this.stopTimers()
    this.fireTimer = setInterval(() => {
      this.extinguishNearbyFire().catch((err) => {
        console.log('Fire watcher error:', err.message || err)
      })
    }, 1500)
    this.idleTimer = setInterval(() => this.trackNearbyEntity(), 120)
    this.registerExplosionGuard()
  }

  stopTimers() {
    if (this.fireTimer) { clearInterval(this.fireTimer); this.fireTimer = null }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null }
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
      console.log(`Extinguished fire at ${fireBlock.position}`)
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
      } else if (entity.type === 'mob' && name !== 'enderman') {
        this.bot.lookAt(entity.position)
      }
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
