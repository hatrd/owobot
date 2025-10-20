// Night auto-sleep: when it is night and a bed is nearby, attempt to sleep.
// No pathfinding; assume player brings the bot near a bed.

const { Vec3 } = require('vec3')

function isNight (bot) {
  try {
    const tod = bot.time?.timeOfDay
    if (typeof tod === 'number') return tod >= 13000 && tod <= 23000
  } catch {}
  try { if (bot.time && typeof bot.time.day === 'boolean') return !bot.time.day } catch {}
  return false
}

function isBedBlock (block) {
  if (!block) return false
  const name = String(block.name || '')
  return name.endsWith('_bed') || name === 'bed'
}

function findBedAroundBot (bot, radius = 3) {
  if (!bot.entity) return null
  const base = bot.entity.position.floored()
  let best = null
  let bestDist2 = Infinity
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = new Vec3(base.x + dx, base.y + dy, base.z + dz)
        const b = bot.blockAt(p)
        if (!isBedBlock(b)) continue
        const d2 = p.distanceTo(bot.entity.position)
        if (d2 < bestDist2) { best = b; bestDist2 = d2 }
      }
    }
  }
  return best
}

function install (bot, { on, dlog, state, registerCleanup, log }) {
  // Route dlog through namespaced logger if present
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  state.sleepingInProgress = Boolean(state.sleepingInProgress)
  state.sleepNoBedLastNotified = state.sleepNoBedLastNotified || 0
  state.sleepLastStart = state.sleepLastStart || 0
  const rawCooldown = Number(state.sleepCooldownUntil)
  state.sleepCooldownUntil = Number.isFinite(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0
  state.sleepFailure = state.sleepFailure || { reason: null, count: 0, lastAt: 0 }
  state.sleepCooldownLog = (state.sleepCooldownLog && typeof state.sleepCooldownLog === 'object') ? state.sleepCooldownLog : Object.create(null)
  let timer = null
  let lastAttemptAt = 0
  let inFlight = false
  const COOLDOWN_MS = 3000
  const NO_BED_NOTIFY_INTERVAL_MS = 60000
  const DISTURBED_RETRY_COOLDOWN_MS = 15000
  const MIN_SLEEP_DURATION_MS = 4000
  const POST_WAKE_COOLDOWN_MS = 5000
  const FAILURE_DECAY_MS = 5 * 60 * 1000
  const FAILURE_LOG_REPEAT_MS = 3 * 60 * 1000
  const FAILURE_BASE = {
    occupied: 10000,
    too_far: 8000,
    unsafe: 15000,
    not_night: 12000,
    generic: 6000
  }
  const FAILURE_MAX = {
    occupied: 30000,
    too_far: 20000,
    unsafe: 60000,
    not_night: 45000,
    generic: 20000
  }
  const FAILURE_CAP = {
    occupied: 3,
    too_far: 2,
    unsafe: 4,
    not_night: 3,
    generic: 2
  }

  function scheduleFailureCooldown (durationMs, label) {
    if (!durationMs || durationMs <= 0) return
    const now = Date.now()
    const target = now + durationMs
    if (!state.sleepCooldownUntil || state.sleepCooldownUntil < target) {
      state.sleepCooldownUntil = target
      const key = label || 'generic'
      const existing = state.sleepCooldownLog[key] || { duration: 0, lastLoggedAt: 0, lastScheduledAt: 0 }
      const prevDuration = existing.duration
      const prevLoggedAt = existing.lastLoggedAt
      const shouldLog = false
      existing.duration = durationMs
      existing.lastScheduledAt = now
      if (shouldLog) {
        existing.lastLoggedAt = now
        const msg = 'sleep: failure cooldown ' + durationMs + 'ms' + (label ? ' (' + label + ')' : '')
        if (log?.info) log.info(msg)
        else dlog && dlog(msg)
      } else {
        dlog && dlog('sleep: failure cooldown muted ' + durationMs + 'ms' + (label ? ' (' + label + ')' : ''))
      }
      state.sleepCooldownLog[key] = existing
    }
  }

  function classifyFailure (message) {
    if (!message) return 'generic'
    const lower = message.toLowerCase()
    if (lower.includes('occupied')) return 'occupied'
    if (lower.includes('too far') || lower.includes('far away')) return 'too_far'
    if (lower.includes('not safe') || lower.includes('monsters')) return 'unsafe'
    if (lower.includes('not night') || lower.includes('only sleep at night') || lower.includes('you may not rest now')) return 'not_night'
    return 'generic'
  }

  function nextFailureCooldown (reason) {
    if (!reason) return 0
    const base = FAILURE_BASE[reason] || FAILURE_BASE.generic
    const cap = FAILURE_CAP[reason] || FAILURE_CAP.generic
    const max = FAILURE_MAX[reason] || FAILURE_MAX.generic
    const tracker = state.sleepFailure = state.sleepFailure || { reason: null, count: 0, lastAt: 0 }
    const now = Date.now()
    if (tracker.reason !== reason || !tracker.lastAt || (now - tracker.lastAt) > FAILURE_DECAY_MS) {
      tracker.reason = reason
      tracker.count = 1
    } else {
      tracker.count = Math.min((tracker.count || 1) + 1, cap)
    }
    tracker.lastAt = now
    const duration = base * (tracker.count || 1)
    return Math.min(duration, max)
  }

  function resetFailureTracker () {
    if (!state.sleepFailure) state.sleepFailure = { reason: null, count: 0, lastAt: 0 }
    state.sleepFailure.reason = null
    state.sleepFailure.count = 0
    state.sleepFailure.lastAt = 0
    state.sleepCooldownLog = Object.create(null)
  }

  function applyFailureCooldown (err) {
    const message = typeof err?.message === 'string' ? err.message : ''
    const reason = classifyFailure(message)
    if (!reason) return
    const duration = nextFailureCooldown(reason)
    scheduleFailureCooldown(duration, reason)
  }

  function hasOtherPlayersNearby () {
    try {
      const players = bot.players || {}
      return Object.values(players).some((p) => p && p.username && p.username !== bot.username && p.entity)
    } catch {}
    return false
  }

  async function trySleepNearby () {
    if (inFlight) return
    inFlight = true
    if (state) state.sleepingInProgress = true
    try {
      try { if (state?.backInProgress || state?.externalBusy) return } catch {}
      const dimension = String(bot?.game?.dimension || '')
      if (dimension && dimension !== 'minecraft:overworld' && dimension !== 'overworld') {
        if (state.sleepCooldownUntil) state.sleepCooldownUntil = 0
        return
      }
      const tod = bot.time?.timeOfDay
      const night = isNight(bot)
      const now = Date.now()
      if (!Number.isFinite(state.sleepCooldownUntil)) state.sleepCooldownUntil = 0
      dlog && dlog('sleep: tick night=', night, 'isSleeping=', Boolean(bot.isSleeping), 'tod=', tod)
      if (!night) {
        if (state.sleepCooldownUntil && state.sleepCooldownUntil < now) state.sleepCooldownUntil = 0
        return
      }
      if (state.sleepCooldownUntil && now < state.sleepCooldownUntil) {
        dlog && dlog('sleep: cooling down', (state.sleepCooldownUntil - now), 'ms')
        return
      }
      if (bot.isSleeping) { dlog && dlog('sleep: already sleeping') ; return }
      if (now - lastAttemptAt < COOLDOWN_MS) {
        dlog && dlog('sleep: cooldown', (COOLDOWN_MS - (now - lastAttemptAt)), 'ms')
        return
      }
      lastAttemptAt = now
      const bed = findBedAroundBot(bot, 3)
      if (!bed) {
        dlog && dlog('sleep: night, no bed nearby (radius=3)')
        if (hasOtherPlayersNearby()) {
          const notifyGap = now - (state.sleepNoBedLastNotified || 0)
          if (notifyGap >= NO_BED_NOTIFY_INTERVAL_MS) {
            state.sleepNoBedLastNotified = now
            // try { bot.chat('我附近没有床，想跳夜的话请带我到床边喵~') } catch {}
          }
        }
        return
      }
      dlog && dlog('sleep: bed candidate at', bed.position)
      try { await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true) } catch {}
      try {
        await bot.sleep(bed)
        dlog && dlog('sleep: success at', bed.position)
        resetFailureTracker()
      } catch (err) {
        dlog && dlog('sleep: failed', err?.message || String(err))
        applyFailureCooldown(err)
      }
    } finally {
      if (!bot.isSleeping) {
        try { state.sleepingInProgress = false } catch {}
      }
      inFlight = false
    }
  }

  on('spawn', () => {
    if (timer) clearInterval(timer)
    timer = setInterval(trySleepNearby, 1000)
    if (log?.info) log.info('sleep: watcher started')
    else dlog && dlog('sleep: watcher started')
  })

  on('sleep', () => {
    state.sleepNoBedLastNotified = 0
    state.sleepLastStart = Date.now()
    state.sleepingInProgress = true
    resetFailureTracker()
    if (log?.info) log.info('sleep: entered')
    else dlog && dlog('sleep: entered')
  })
  on('wake', () => {
    state.sleepNoBedLastNotified = 0
    state.sleepingInProgress = false
    const now = Date.now()
    const lastStart = state.sleepLastStart || 0
    state.sleepLastStart = 0
    const night = isNight(bot)
    let targetCooldown = now + POST_WAKE_COOLDOWN_MS
    if (night && lastStart && now - lastStart < MIN_SLEEP_DURATION_MS) {
      targetCooldown = now + DISTURBED_RETRY_COOLDOWN_MS
      const msg = 'sleep: disturbed, delaying retry ' + DISTURBED_RETRY_COOLDOWN_MS + 'ms'
      if (log?.info) log.info(msg)
      else dlog && dlog(msg)
    } else if (!night) {
      const msg = 'sleep: post-wake cooldown ' + POST_WAKE_COOLDOWN_MS + 'ms'
      if (log?.info) log.info(msg)
      else dlog && dlog(msg)
    }
    if (!state.sleepCooldownUntil || state.sleepCooldownUntil < targetCooldown) {
      state.sleepCooldownUntil = targetCooldown
    }
    if (log?.info) log.info('sleep: woke up')
    else dlog && dlog('sleep: woke up')
  })

  on('end', () => {
    try { if (timer) clearInterval(timer) } catch {}
    timer = null
    try { state.sleepingInProgress = false } catch {}
    resetFailureTracker()
    if (log?.info) log.info('sleep: watcher stopped')
    else dlog && dlog('sleep: watcher stopped')
  })

  // Hot-reload support: start immediately if already spawned
  if (state?.hasSpawned && !timer) {
    timer = setInterval(trySleepNearby, 1000)
    if (log?.info) log.info('sleep: watcher started (post-reload)')
    else dlog && dlog('sleep: watcher started (post-reload)')
  }

  // Ensure interval cleared on plugin deactivate
  registerCleanup && registerCleanup(() => {
    try { if (timer) clearInterval(timer) } catch {}
    timer = null
    try { state.sleepingInProgress = false } catch {}
    resetFailureTracker()
  })
}

module.exports = { install }
