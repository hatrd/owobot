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

function install (bot, { on, dlog, state, registerCleanup }) {
  state.sleepingInProgress = state.sleepingInProgress || false
  let timer = null
  let lastAttemptAt = 0
  const COOLDOWN_MS = 3000

  async function trySleepNearby () {
    const tod = bot.time?.timeOfDay
    const night = isNight(bot)
    dlog && dlog('sleep: tick night=', night, 'isSleeping=', Boolean(bot.isSleeping), 'tod=', tod)
    if (!night) return
    if (bot.isSleeping) { dlog && dlog('sleep: already sleeping') ; return }
    const now = Date.now()
    if (now - lastAttemptAt < COOLDOWN_MS) {
      dlog && dlog('sleep: cooldown', (COOLDOWN_MS - (now - lastAttemptAt)), 'ms')
      return
    }
    lastAttemptAt = now
    const bed = findBedAroundBot(bot, 3)
    if (!bed) { dlog && dlog('sleep: night, no bed nearby (radius=3)') ; return }
    dlog && dlog('sleep: bed candidate at', bed.position)
    try { await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true) } catch {}
    try {
      await bot.sleep(bed)
      dlog && dlog('sleep: success at', bed.position)
    } catch (err) {
      dlog && dlog('sleep: failed', err?.message || String(err))
    }
  }

  on('spawn', () => {
    if (timer) clearInterval(timer)
    timer = setInterval(trySleepNearby, 1000)
    dlog && dlog('sleep: watcher started')
  })

  on('sleep', () => { dlog && dlog('sleep: entered') })
  on('wake', () => { dlog && dlog('sleep: woke up') })

  on('end', () => {
    try { if (timer) clearInterval(timer) } catch {}
    timer = null
    dlog && dlog('sleep: watcher stopped')
  })

  // Hot-reload support: start immediately if already spawned
  if (state?.hasSpawned && !timer) {
    timer = setInterval(trySleepNearby, 1000)
    dlog && dlog('sleep: watcher started (post-reload)')
  }

  // Ensure interval cleared on plugin deactivate
  registerCleanup && registerCleanup(() => { try { if (timer) clearInterval(timer) } catch {} ; timer = null })
}

module.exports = { install }
