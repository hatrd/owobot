// Auto-totem: when recently hurt and health is dangerously low,
// immediately equip a totem of undying into off-hand if available.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  const HEALTH_AT = Number(process.env.AUTO_TOTEM_HEALTH_AT || 10)
  const RECENT_HURT_MS = Number(process.env.AUTO_TOTEM_RECENT_HURT_MS || 2500)
  const RETRY_MS = Number(process.env.AUTO_TOTEM_RETRY_MS || 120)
  const EQUIP_COOLDOWN_MS = Number(process.env.AUTO_TOTEM_EQUIP_COOLDOWN_MS || 180)

  state.autoTotem = state.autoTotem || {
    enabled: true,
    triggerHealth: HEALTH_AT,
    lastEquipAt: 0,
    lastReason: null
  }

  let lastHurtAt = 0
  let equipRunning = false
  let retryTimer = null

  function now () { return Date.now() }

  function itemName (it) {
    return String(it?.name || '').toLowerCase()
  }

  function hasTotemInOffhand () {
    try {
      return itemName(bot.inventory?.slots?.[45]) === 'totem_of_undying'
    } catch {
      return false
    }
  }

  function findTotemCandidate () {
    const inv = bot.inventory?.items?.() || []
    const held = bot.heldItem
    const off = bot.inventory?.slots?.[45]
    const all = inv.concat([held, off].filter(Boolean))
    for (const it of all) {
      if (itemName(it) === 'totem_of_undying') return it
    }
    return null
  }

  function healthValue () {
    const hp = Number(bot.health)
    return Number.isFinite(hp) ? hp : null
  }

  function isDangerNow () {
    const hp = healthValue()
    if (hp == null) return false
    if (hp <= Math.min(4, HEALTH_AT)) return true
    return hp <= HEALTH_AT && (now() - lastHurtAt) <= RECENT_HURT_MS
  }

  function scheduleRetry (reason) {
    if (retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      ensureTotemOffhand(reason).catch(() => {})
    }, Math.max(30, RETRY_MS))
  }

  async function ensureTotemOffhand (reason) {
    if (state?.autoTotem?.enabled === false) return false
    if (!isDangerNow()) return false
    if (hasTotemInOffhand()) return true
    if (equipRunning) return false

    const ts = now()
    const lastEquipAt = Number(state?.autoTotem?.lastEquipAt || 0)
    if (ts - lastEquipAt < EQUIP_COOLDOWN_MS) return false

    const totem = findTotemCandidate()
    if (!totem) return false

    equipRunning = true
    try {
      await bot.equip(totem, 'off-hand')
      state.autoTotem.lastEquipAt = now()
      state.autoTotem.lastReason = reason || 'unknown'
      dlog && dlog('auto-totem equipped', { health: bot.health, reason: state.autoTotem.lastReason })
      return true
    } catch (err) {
      dlog && dlog('auto-totem equip failed', err?.message || String(err))
      return false
    } finally {
      equipRunning = false
    }
  }

  function onHurt (entity) {
    try {
      if (entity !== bot.entity) return
      lastHurtAt = now()
      ensureTotemOffhand('hurt').then((ok) => {
        if (!ok && isDangerNow()) scheduleRetry('hurt-retry')
      }).catch(() => {})
    } catch {}
  }

  function onHealth () {
    try {
      if (!isDangerNow()) return
      ensureTotemOffhand('health').then((ok) => {
        if (!ok && isDangerNow()) scheduleRetry('health-retry')
      }).catch(() => {})
    } catch {}
  }

  on('entityHurt', onHurt)
  on('health', onHealth)
  on('agent:stop_all', () => {
    if (retryTimer) {
      try { clearTimeout(retryTimer) } catch {}
      retryTimer = null
    }
  })
  on('end', () => {
    if (retryTimer) {
      try { clearTimeout(retryTimer) } catch {}
      retryTimer = null
    }
  })

  registerCleanup && registerCleanup(() => {
    if (retryTimer) {
      try { clearTimeout(retryTimer) } catch {}
      retryTimer = null
    }
  })
}

module.exports = { install }
