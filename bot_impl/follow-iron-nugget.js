// Follows the nearest player holding an Iron Nugget, using pathfinder.
// Always-on behavior; lightweight polling to choose target; cleans up on reload.

function install (bot, { on, dlog, state, registerCleanup }) {
  let enabled = true
  let interval = null
  let currentTarget = null
  let mcData = null
  let pathfinderPkg = null
  let lastHeartbeat = 0
  let lastRetreatAt = 0
  const DESIRED_DIST = 3.2 // preferred standoff distance
  const FOLLOW_RANGE = 3.2 // GoalFollow range
  const MIN_DIST = 2.5     // too close; move to offset point instead of following
  const RESUME_DIST = 3.6  // when paused for being close, resume follow once beyond this
  let mode = 'idle'        // 'idle' | 'follow' | 'offset'
  const holders = new Map() // entityId -> { entity, username, lastSeen }
  let lockedTargetId = null
  let lastHoldersRefresh = 0

  function ensurePathfinderLoaded () {
    if (state.__pathfinderLoaded) return true
    try {
      pathfinderPkg = require('mineflayer-pathfinder')
      bot.loadPlugin(pathfinderPkg.pathfinder)
      state.__pathfinderLoaded = true
      dlog && dlog('follow:pathfinder: loaded')
      return true
    } catch (e) {
      console.log('follow:pathfinder: not installed. Run: npm i mineflayer-pathfinder')
      return false
    }
  }

  function ensureMcData () {
    try {
      mcData = bot.mcData || require('minecraft-data')(bot.version)
      bot.mcData = mcData
      const id = getIronNuggetId()
      dlog && dlog('follow:mcData ready; iron_nugget id =', id)
    } catch {}
  }

  function getIronNuggetId () {
    if (!mcData) return null
    const i = mcData.itemsByName?.iron_nugget
    return i?.id ?? null
  }

  function isHoldingIronNugget (entity) {
    try {
      const heldMain = entity?.heldItem || (entity?.equipment ? entity.equipment[0] : null)
      const heldOff = entity?.equipment ? entity.equipment[1] : null
      if (!heldMain && !heldOff) return false
      const id = getIronNuggetId()
      if (id == null) return false
      return (heldMain && heldMain.type === id) || (heldOff && heldOff.type === id)
    } catch { return false }
  }

  function updateHolderStatus (entity) {
    if (!entity || entity.type !== 'player') return
    if (!mcData) ensureMcData()
    const now = Date.now()
    const has = isHoldingIronNugget(entity)
    const name = entity.username || entity.name || entity.id
    if (has) {
      holders.set(entity.id, { entity, username: name, lastSeen: now })
      dlog && dlog('follow: holder seen ->', name)
    } else {
      if (holders.has(entity.id)) {
        holders.delete(entity.id)
        dlog && dlog('follow: holder cleared ->', name)
      }
    }
  }

  function refreshHoldersFromPlayers () {
    const now = Date.now()
    if (now - lastHoldersRefresh < 1200) return
    lastHoldersRefresh = now
    const list = Object.values(bot.players || {}).map(p => p?.entity).filter(Boolean)
    for (const e of list) updateHolderStatus(e)
  }

  function chooseTarget () {
    refreshHoldersFromPlayers()
    const now = Date.now()
    const candidates = []
    for (const { entity, username, lastSeen } of holders.values()) {
      if (!entity || !entity.position) continue
      if (now - lastSeen > 8000) continue
      const dist = entity.position.distanceTo(bot.entity.position)
      if (dist > 64) continue
      candidates.push({ entity, username, dist })
    }
    candidates.sort((a, b) => a.dist - b.dist)

    let chosen = null
    // Honor lock if still valid
    if (lockedTargetId) {
      chosen = candidates.find(c => c.entity.id === lockedTargetId) || null
      if (!chosen) {
        dlog && dlog('follow: lock expired for id', lockedTargetId)
        lockedTargetId = null
      }
    }
    // If no lock, pick nearest and lock to it
    if (!chosen && candidates.length > 0) {
      chosen = candidates[0]
      lockedTargetId = chosen.entity.id
      dlog && dlog('follow: locked to', chosen.username)
    }

    dlog && dlog('follow: candidates =', candidates.length, 'chosen =', chosen ? chosen.username : null, 'dist =', chosen ? chosen.dist.toFixed(2) : null)
    return chosen ? chosen.entity : null
  }

  async function applyFollowTarget (target) {
    if (!ensurePathfinderLoaded()) return
    ensureMcData()
    const { Movements, goals } = pathfinderPkg || require('mineflayer-pathfinder')
    const movements = new Movements(bot, mcData)
    // Reasonable defaults; allow parkour off by default, dig if necessary
    movements.allow1by1towers = true
    movements.canDig = true
    movements.allowSprinting = true
    bot.pathfinder.setMovements(movements)

    if (target) {
      if (currentTarget?.id === target.id && bot.pathfinder.goal) return
      currentTarget = target
      const range = FOLLOW_RANGE
      bot.pathfinder.setGoal(new goals.GoalFollow(target, range), true)
      mode = 'follow'
      dlog && dlog('follow: setGoal GoalFollow ->', target?.username || target?.name || target?.id)
    } else {
      currentTarget = null
      bot.pathfinder.setGoal(null)
      mode = 'idle'
      dlog && dlog('follow: cleared target')
    }
  }

  function retreatFrom (target) {
    try {
      const now = Date.now()
      if (now - lastRetreatAt < 800) return
      lastRetreatAt = now
      const dir = bot.entity.position.minus(target.position)
      const look = target.position // look toward target so that 'back' moves away
      bot.lookAt(look, true).catch(() => {})
      bot.setControlState('sprint', false)
      bot.setControlState('forward', false)
      bot.setControlState('back', true)
      setTimeout(() => {
        bot.setControlState('back', false)
      }, 300)
      dlog && dlog('follow: retreating briefly from target')
    } catch {}
  }

  function offsetPointBehind (entity, dist) {
    const yaw = (typeof entity.yaw === 'number') ? entity.yaw : 0
    const dx = -Math.sin(yaw) * dist
    const dz =  Math.cos(yaw) * dist
    const x = entity.position.x + dx
    const z = entity.position.z + dz
    const y = entity.position.y
    return { x, y, z }
  }

  function setOffsetGoal (target) {
    if (!ensurePathfinderLoaded()) return
    const { goals } = pathfinderPkg || require('mineflayer-pathfinder')
    const p = offsetPointBehind(target, DESIRED_DIST)
    const r = 0.9
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, r))
    mode = 'offset'
    dlog && dlog('follow: setGoal GoalNear (behind) ->', JSON.stringify(p))
  }

  function tick () {
    if (!enabled) return
    if (!bot.entity || !bot.entity.position) return
    const target = chooseTarget()
    if (!target && currentTarget) {
      applyFollowTarget(null)
      return
    }
    if (target) {
      const dist = target.position.distanceTo(bot.entity.position)
      if (!currentTarget || currentTarget.id !== target.id) {
        applyFollowTarget(target)
      } else {
        if (dist < MIN_DIST) {
          // Too close: go to a point behind the player
          setOffsetGoal(target)
          // Optional small retreat impulse to break collision
          retreatFrom(target)
        } else if (dist > RESUME_DIST) {
          if (mode !== 'follow' || !bot.pathfinder.goal) {
            dlog && dlog('follow: resume follow, dist=', dist.toFixed(2))
            applyFollowTarget(target)
          }
        } else {
          // In comfortable band: ensure we aren't actively pushing
          if (mode === 'follow' && dist < DESIRED_DIST - 0.4) {
            // Switch temporarily to offset to stop closing further
            setOffsetGoal(target)
          }
        }
      }
    }
    const now = Date.now()
    if (now - lastHeartbeat > 2000) {
      lastHeartbeat = now
      const tname = currentTarget ? (currentTarget.username || currentTarget.name || currentTarget.id) : null
      const dist = currentTarget ? currentTarget.position.distanceTo(bot.entity.position).toFixed(2) : null
      dlog && dlog('follow: heartbeat target=', tname, 'dist=', dist, 'goal=', Boolean(bot.pathfinder && bot.pathfinder.goal))
    }
  }

  function startPolling () {
    ensureMcData()
    if (!interval) interval = setInterval(tick, 400)
    dlog && dlog('follow: installed; polling started')
  }
  on('spawn', startPolling)

  on('entityEquip', (entity) => {
    // React faster when someone changes held item nearby
    try {
      if (!entity || entity.type !== 'player') return
      const me = bot.entity
      if (!me) return
      if (entity.position.distanceTo(me.position) > 48) return
      const held = entity?.heldItem || (entity?.equipment ? entity.equipment[0] : null)
      dlog && dlog('follow: entityEquip for', entity.username || entity.name || entity.id, 'held=', held ? { id: held.type, name: mcData?.items[held.type]?.name } : null)
      updateHolderStatus(entity)
      // Re-evaluate target immediately
      tick()
    } catch {}
  })

  // Some servers emit a different event name; log if seen
  on('entityEquipmentChange', (entity) => {
    try {
      if (!entity || entity.type !== 'player') return
      dlog && dlog('follow: entityEquipmentChange seen for', entity.username || entity.name || entity.id)
      updateHolderStatus(entity)
      tick()
    } catch {}
  })

  on('end', () => {
    try { if (interval) clearInterval(interval) } catch {}
    interval = null
    if (bot.pathfinder) {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    dlog && dlog('follow: cleaned up on end')
  })

  // Hot-reload support: start immediately if already spawned
  if (state?.hasSpawned) startPolling()

  // Ensure interval cleared on plugin deactivate
  registerCleanup && registerCleanup(() => { try { if (interval) clearInterval(interval) } catch {} ; interval = null })
}

module.exports = { install }
