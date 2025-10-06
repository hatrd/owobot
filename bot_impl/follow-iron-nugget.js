// Minimal follow: if a player holds an iron nugget, follow the nearest holder.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  let interval = null
  let currentTarget = null
  let mcData = null
  let pathfinderPkg = null
  let lastHeartbeat = 0

  function ensurePathfinderLoaded () {
    try {
      if (!pathfinderPkg) pathfinderPkg = require('mineflayer-pathfinder')
      if (!bot.pathfinder) bot.loadPlugin(pathfinderPkg.pathfinder)
      return true
    } catch (e) {
      console.warn('follow: install mineflayer-pathfinder to enable following')
      return false
    }
  }

  function ensureMcData () {
    try { mcData = bot.mcData || require('minecraft-data')(bot.version); bot.mcData = mcData } catch {}
  }

  function ironId () { ensureMcData(); return mcData?.itemsByName?.iron_nugget?.id ?? null }

  function isHoldingIron (entity) {
    try {
      const id = ironId(); if (id == null) return false
      const main = entity?.heldItem || (entity?.equipment ? entity.equipment[0] : null)
      const off = entity?.equipment ? entity.equipment[1] : null
      return (main && main.type === id) || (off && off.type === id)
    } catch { return false }
  }

  function nearestHolder () {
    let best = null; let bestDist = Infinity
    for (const [name, rec] of Object.entries(bot.players || {})) {
      const e = rec?.entity
      if (!e || e === bot.entity) continue
      if (e.type !== 'player') continue
      if (!isHoldingIron(e)) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < bestDist) { best = e; bestDist = d }
    }
    if (best) dlog && dlog('target=', best.username || best.name || best.id, 'dist=', best.position.distanceTo(bot.entity.position).toFixed(2), 'type=', best.type)
    return best
  }

  function setAutoLookSuspended (val) { try { if (state) state.autoLookSuspended = !!val } catch {} }

  function tick () {
    if (!bot.entity || !bot.entity.position) return
    const target = nearestHolder()
    if (!target) {
      if (currentTarget) {
        try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
        currentTarget = null
        setAutoLookSuspended(false)
        dlog && dlog('cleared target')
      }
      return
    }

    if (!currentTarget || currentTarget.id !== target.id) {
      if (!ensurePathfinderLoaded()) return
      const { Movements, goals } = pathfinderPkg
      const movements = new Movements(bot, mcData)
      movements.canDig = true
      movements.allowSprinting = true
      bot.pathfinder.setMovements(movements)
      currentTarget = target
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
      setAutoLookSuspended(true)
      dlog && dlog('setGoal GoalFollow ->', target.username || target.name || target.id)
    } else {
      // If current target stops holding the item, stop following immediately
      if (!isHoldingIron(currentTarget)) {
        try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
        currentTarget = null
        setAutoLookSuspended(false)
        dlog && dlog('cleared target (no longer holding)')
      }
    }

    const now = Date.now()
    if (now - lastHeartbeat > 2000) {
      lastHeartbeat = now
      const tname = currentTarget ? (currentTarget.username || currentTarget.name || currentTarget.id) : null
      const dist = currentTarget ? currentTarget.position.distanceTo(bot.entity.position).toFixed(2) : null
      dlog && dlog('heartbeat target=', tname, 'dist=', dist, 'goal=', Boolean(bot.pathfinder && bot.pathfinder.goal))
    }
  }

  function start () { if (!interval) interval = setInterval(tick, 400); dlog && dlog('started') }
  on('spawn', start)
  if (state?.hasSpawned) start()

  on('entityEquip', (entity) => { try { if (entity?.type === 'player') tick() } catch {} })
  on('entityEquipmentChange', (entity) => { try { if (entity?.type === 'player') tick() } catch {} })

  on('end', () => { try { if (interval) clearInterval(interval) } catch {}; interval = null; try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}; setAutoLookSuspended(false) })
  registerCleanup && registerCleanup(() => { try { if (interval) clearInterval(interval) } catch {}; interval = null; setAutoLookSuspended(false) })
}

module.exports = { install }
// Minimal follow: if a player holds an iron nugget, follow the nearest holder.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  let interval = null
  let currentTarget = null
  let mcData = null
  let pathfinderPkg = null
  let lastHeartbeat = 0

  function ensurePathfinderLoaded () {
    try {
      if (!pathfinderPkg) pathfinderPkg = require('mineflayer-pathfinder')
      if (!bot.pathfinder) bot.loadPlugin(pathfinderPkg.pathfinder)
      return true
    } catch (e) {
      console.warn('follow: install mineflayer-pathfinder to enable following')
      return false
    }
  }

  function ensureMcData () {
    try { mcData = bot.mcData || require('minecraft-data')(bot.version); bot.mcData = mcData } catch {}
  }

  function ironId () { ensureMcData(); return mcData?.itemsByName?.iron_nugget?.id ?? null }

  function isHoldingIron (entity) {
    try {
      const id = ironId(); if (id == null) return false
      const main = entity?.heldItem || (entity?.equipment ? entity.equipment[0] : null)
      const off = entity?.equipment ? entity.equipment[1] : null
      return (main && main.type === id) || (off && off.type === id)
    } catch { return false }
  }

  function nearestHolder () {
    let best = null; let bestDist = Infinity
    for (const rec of Object.values(bot.players || {})) {
      const e = rec?.entity
      if (!e || e === bot.entity) continue
      if (!isHoldingIron(e)) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < bestDist) { best = e; bestDist = d }
    }
    if (best) dlog && dlog('target=', best.username || best.name || best.id, 'dist=', best.position.distanceTo(bot.entity.position).toFixed(2))
    return best
  }

  function tick () {
    if (!bot.entity || !bot.entity.position) return
    const target = nearestHolder()
    if (!target) {
      if (currentTarget) {
        try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
        currentTarget = null
        dlog && dlog('cleared target')
      }
    } else if (!currentTarget || currentTarget.id !== target.id) {
      if (!ensurePathfinderLoaded()) return
      const { Movements, goals } = pathfinderPkg
      const movements = new Movements(bot, mcData)
      movements.canDig = true
      movements.allowSprinting = true
      bot.pathfinder.setMovements(movements)
      currentTarget = target
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
      dlog && dlog('setGoal GoalFollow ->', target.username || target.name || target.id)
    }

    const now = Date.now()
    if (now - lastHeartbeat > 2000) {
      lastHeartbeat = now
      const tname = currentTarget ? (currentTarget.username || currentTarget.name || currentTarget.id) : null
      const dist = currentTarget ? currentTarget.position.distanceTo(bot.entity.position).toFixed(2) : null
      dlog && dlog('heartbeat target=', tname, 'dist=', dist, 'goal=', Boolean(bot.pathfinder && bot.pathfinder.goal))
    }
  }

  function start () { if (!interval) interval = setInterval(tick, 400); dlog && dlog('started') }
  on('spawn', start)
  if (state?.hasSpawned) start()

  on('entityEquip', (entity) => { try { if (entity?.type === 'player') tick() } catch {} })
  on('entityEquipmentChange', (entity) => { try { if (entity?.type === 'player') tick() } catch {} })

  on('end', () => { try { if (interval) clearInterval(interval) } catch {}; interval = null; try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} })
  registerCleanup && registerCleanup(() => { try { if (interval) clearInterval(interval) } catch {}; interval = null })
}

module.exports = { install }
