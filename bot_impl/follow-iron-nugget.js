// Minimal follow: if a player holds an iron nugget, follow the nearest holder.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const L = log || { info: (...a) => console.log('[FOLLOW]', ...a), debug: (...a) => (dlog ? dlog(...a) : console.log('[FOLLOW]', ...a)) }
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  let interval = null
  let currentTarget = null
  let mcData = null
  let pathfinderPkg = null
  let lastHeartbeat = 0
  // runtime cfg persisted in state
  const S = state.followIron = state.followIron || {}
  const cfg = S.cfg = Object.assign({ debug: false, canDig: false, doorAssist: true, parkour: false, towers: false, heartbeatMs: 2000 }, S.cfg || {})

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

  // --- Door helpers (open wooden doors/fence gates opportunistically) ---
  const { Vec3 } = require('vec3')
  let doorCooldownUntil = 0
  let doorTempGoalUntil = 0
  let doorBusy = false

  function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

  async function walkToPos (pos, range = 1, timeoutMs = 5000) {
    try {
      if (!pathfinderPkg) pathfinderPkg = require('mineflayer-pathfinder')
      const { goals } = pathfinderPkg
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(0, range)), true)
      const until = Date.now() + Math.max(1000, timeoutMs)
      await sleep(200)
      while (Date.now() < until) {
        await sleep(80)
        if (!bot.pathfinder?.isMoving?.()) break
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      if (cfg.debug) L.info('walkToPos done ->', `${pos.x},${pos.y},${pos.z}`, 'range=', range)
      return true
    } catch { return false }
  }

  async function walkThroughDoorBlock (block) {
    try {
      if (!block) return false
      if (cfg.debug) L.info('door: walkThrough start name=', block.name, 'at', `${block.position.x},${block.position.y},${block.position.z}`)
      // Approach the door closely
      await walkToPos(block.position, 1, 5000)
      // Open the door/gate
      try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await bot.activateBlock(block); if (cfg.debug) L.info('door: activate open issued') } catch (e) { if (cfg.debug) L.info('door: activate failed', e?.message || e) }
      // Push forward for a short while to pass the frame
      try { bot.setControlState('forward', true) } catch {}
      await sleep(600)
      try { bot.setControlState('forward', false) } catch {}
      // Optionally, set a tiny goal just beyond the door toward target to ensure passing the threshold
      try {
        if (pathfinderPkg && currentTarget && currentTarget.position) {
          const step = new Vec3(Math.sign(currentTarget.position.x - bot.entity.position.x) || 0, 0, Math.sign(currentTarget.position.z - bot.entity.position.z) || 0)
          const dest = block.position.offset(step.x, 0, step.z)
          const { goals } = pathfinderPkg
          bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, 0), true)
          doorTempGoalUntil = Date.now() + 800
          if (cfg.debug) L.info('door: temp goal beyond ->', `${dest.x},${dest.y},${dest.z}`)
        }
      } catch {}
      // Resume following
      try {
        if (pathfinderPkg && currentTarget) {
          const { goals } = pathfinderPkg
          bot.pathfinder.setGoal(new goals.GoalFollow(currentTarget, 3), true)
          if (cfg.debug) L.info('door: resume follow')
        }
      } catch {}
      return true
    } catch { return false }
  }
  function isDoorLikeName (n) { const s = String(n||'').toLowerCase(); return s.includes('_door') || s.includes('fence_gate') || s.endsWith('gate') }
  function isDoorLikeBlock (b) { try { return b && isDoorLikeName(b.name) } catch { return false } }
  function isOpenDoorLike (b) {
    try {
      const p = b?.getProperties?.(); if (p && typeof p.open === 'boolean') return !!p.open
      // fallback heuristic: some doors have empty shapes when open; if so treat as open
      if (Array.isArray(b?.shapes) && b.shapes.length === 0) return true
    } catch {}
    return false
  }
  async function tryOpenDoorAt (pos) {
    try {
      const b = bot.blockAt(pos)
      if (!isDoorLikeBlock(b)) return false
      if (isOpenDoorLike(b)) return false
      if (Date.now() < doorCooldownUntil) return false
      doorCooldownUntil = Date.now() + 600
      try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await bot.activateBlock(b) } catch {}
      return true
    } catch { return false }
  }
  async function assistDoorIfBlocking (target) {
    try {
      if (doorBusy) return
      const me = bot.entity?.position; if (!me || !target?.position) return
      const base = me.floored ? me.floored() : new Vec3(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
      // Candidate positions around us (feet/head) to check for door-like blocks
      const dirs = [
        new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1), // cardinal
        new Vec3(1,0,1), new Vec3(1,0,-1), new Vec3(-1,0,1), new Vec3(-1,0,-1) // diagonals
      ]
      const cand = []
      for (const d of dirs) { cand.push(base.offset(d.x, 0, d.z)); cand.push(base.offset(d.x, 1, d.z)) }
      // also 2-ahead in cardinal direction towards target
      const fx = Math.sign(target.position.x - me.x) || 0
      const fz = Math.sign(target.position.z - me.z) || 0
      if (fx !== 0 || fz !== 0) {
        cand.push(base.offset(fx * 2, 0, fz * 2))
        cand.push(base.offset(fx * 2, 1, fz * 2))
        cand.push(base.offset(fx * 1, 0, fz * 2))
        cand.push(base.offset(fx * 1, 1, fz * 2))
        cand.push(base.offset(fx * 2, 0, fz * 1))
        cand.push(base.offset(fx * 2, 1, fz * 1))
      }
      // Also include our own feet block (door center case)
      cand.push(base); cand.push(base.offset(0,1,0))
      if (cfg.debug) L.info('door: scan cand=', cand.length, 'base=', `${base.x},${base.y},${base.z}`)
      // If there is a closed door around, perform explicit door pass sequence
      let doorBlock = null
      let doorOpenSeen = false
      for (const p of cand) {
        const b = bot.blockAt(p)
        if (!isDoorLikeBlock(b)) continue
        // Skip iron doors - cannot open without redstone
        if (String(b.name||'').toLowerCase().includes('iron_door')) continue
        const open = isOpenDoorLike(b)
        if (cfg.debug) L.info('door: seen', b.name, 'at', `${p.x},${p.y},${p.z}`, 'open=', open)
        if (!open && !doorBlock) doorBlock = b
        if (open) doorOpenSeen = true
      }
      if (doorBlock && !isOpenDoorLike(doorBlock)) {
        if (cfg.debug) L.info('door: found closed door', doorBlock.name, 'at', `${doorBlock.position.x},${doorBlock.position.y},${doorBlock.position.z}`)
        doorBusy = true
        try { await walkThroughDoorBlock(doorBlock) } finally { doorBusy = false }
        // hold a short window before resetting follow to avoid fight
        doorTempGoalUntil = Date.now() + 800
        return
      }
      // If we are standing in a door block, micro nudge forward
      const here = bot.blockAt(base)
      if (isDoorLikeBlock(here) && isOpenDoorLike(here)) {
        if (cfg.debug) L.info('door: inside open door -> nudge forward')
        try { bot.setControlState('forward', true) } catch {}
        await new Promise(r => setTimeout(r, 200))
        try { bot.setControlState('forward', false) } catch {}
        return
      }
      // If we saw an open door nearby but not inside it, give a tiny forward nudge to step through
      if (doorOpenSeen) {
        try { bot.setControlState('forward', true) } catch {}
        await new Promise(r => setTimeout(r, 220))
        try { bot.setControlState('forward', false) } catch {}
      }
    } catch {}
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
    try { if (state?.externalBusy || state?.holdItemLock) {
      if (currentTarget) { try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} ; currentTarget = null }
      setAutoLookSuspended(false)
      return
    } } catch {}
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
      // Respect runtime cfg
      movements.canDig = !!cfg.canDig
      movements.canOpenDoors = true
      movements.allowSprinting = true
      movements.allowParkour = !!cfg.parkour
      movements.allow1by1towers = !!cfg.towers
      bot.pathfinder.setMovements(movements)
      currentTarget = target
      // If a temporary door goal is active, keep it for a short time; otherwise follow
      if (Date.now() >= doorTempGoalUntil && !doorBusy) bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
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
    if (now - lastHeartbeat > Math.max(800, cfg.heartbeatMs)) {
      lastHeartbeat = now
      const tname = currentTarget ? (currentTarget.username || currentTarget.name || currentTarget.id) : null
      const dist = currentTarget ? currentTarget.position.distanceTo(bot.entity.position).toFixed(2) : null
      if (cfg.debug) L.info('heartbeat target=', tname, 'dist=', dist, 'goal=', Boolean(bot.pathfinder && bot.pathfinder.goal), 'doorBusy=', doorBusy)
    }
    // Try to open doors/gates that block the way
    if (currentTarget && cfg.doorAssist) assistDoorIfBlocking(currentTarget).catch(() => {})
  }

  function start () { if (!interval) interval = setInterval(tick, 400); dlog && dlog('started') }
  on('spawn', start)
  if (state?.hasSpawned) start()

  on('entityEquip', (entity) => { try { if (entity?.type === 'player') tick() } catch {} })
  on('entityEquipmentChange', (entity) => { try { if (entity?.type === 'player') tick() } catch {} })

  on('end', () => { try { if (interval) clearInterval(interval) } catch {}; interval = null; try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}; setAutoLookSuspended(false) })
  on('agent:stop_all', () => { try { if (interval) clearInterval(interval) } catch {}; interval = null; try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}; setAutoLookSuspended(false) })
  registerCleanup && registerCleanup(() => { try { if (interval) clearInterval(interval) } catch {}; interval = null; setAutoLookSuspended(false) })

  // CLI: .follow debug on|off|status|dig on|off|door on|off|parkour on|off|towers on|off
  on('cli', ({ cmd, args }) => {
    if (String(cmd||'').toLowerCase() !== 'follow') return
    const sub = String(args[0]||'').toLowerCase()
    const val = String(args[1]||'').toLowerCase()
    const onoff = (v) => !(v === 'off' || v === '0' || v === 'false' || v === 'no')
    switch (sub) {
      case 'status':
        console.log('[FOLLOW] status debug=', cfg.debug, 'canDig=', cfg.canDig, 'doorAssist=', cfg.doorAssist, 'parkour=', cfg.parkour, 'towers=', cfg.towers, 'hbMs=', cfg.heartbeatMs)
        break
      case 'debug': cfg.debug = onoff(val); console.log('[FOLLOW] debug=', cfg.debug); break
      case 'dig': cfg.canDig = onoff(val); console.log('[FOLLOW] canDig=', cfg.canDig); break
      case 'door': cfg.doorAssist = onoff(val); console.log('[FOLLOW] doorAssist=', cfg.doorAssist); break
      case 'parkour': cfg.parkour = onoff(val); console.log('[FOLLOW] parkour=', cfg.parkour); break
      case 'towers': cfg.towers = onoff(val); console.log('[FOLLOW] towers=', cfg.towers); break
      case 'hb': cfg.heartbeatMs = Math.max(500, parseInt(args[1]||'2000', 10)); console.log('[FOLLOW] heartbeatMs=', cfg.heartbeatMs); break
      default: console.log('[FOLLOW] usage: .follow status|debug on|off|dig on|off|door on|off|parkour on|off|towers on|off|hb ms')
    }
  })
}

module.exports = { install }
