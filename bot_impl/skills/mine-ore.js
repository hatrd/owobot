// Skill: mine_ore — scan for nearby ore veins and mine them.
// Intent-level: mines ores within a radius, performing simple vein-mining.

module.exports = function mineOreFactory ({ bot, args, log }) {
  const L = log
  const radius = Math.max(4, parseInt(args.radius || '32', 10))
  const only = (() => {
    if (!args.only) return null
    if (Array.isArray(args.only)) return args.only.map(x => String(x).toLowerCase())
    return String(args.only).toLowerCase()
  })()
  const maxPerTick = 1
  let inited = false
  let target = null
  let stack = [] // vein DFS stack of positions (Vec3)
  let busy = false
  let gaveUpAt = 0
  let mcData = null
  let pathfinder = null
  let toolSel = null
  let locked = false
  let actions = null
  let exploreUntil = 0
  let lastTrashAt = 0
  const TRASH = Array.isArray(args.trash) ? args.trash.map(s => String(s).toLowerCase()) : ['netherrack']
  const TRASH_MINFREE = Math.max(0, parseInt(args.trashMinFree || '4', 10))
  const TRASH_COOLDOWN_MS = 4000

  function ensureMcData () { try { if (!bot.mcData) bot.mcData = require('minecraft-data')(bot.version) } catch {} ; return bot.mcData }
  function ensurePathfinder () {
    try { if (!pathfinder) pathfinder = require('mineflayer-pathfinder'); if (!bot.pathfinder) bot.loadPlugin(pathfinder.pathfinder); return true } catch { return false }
  }
  function ensureToolSel () { if (!toolSel) toolSel = require('../tool-select'); return toolSel }
  function ensureActions () { if (!actions) { try { actions = require('../actions').install(bot, { log }) } catch {} } return actions }

  function lockHands () {
    try { if (bot.state) { bot.state.holdItemLock = 'pickaxe'; bot.state.externalBusy = true; bot.state.autoLookSuspended = true } } catch {}
    locked = true
  }
  function releaseHands () {
    try { if (bot.state) { if (bot.state.holdItemLock === 'pickaxe') bot.state.holdItemLock = null; bot.state.externalBusy = false; bot.state.autoLookSuspended = false } } catch {}
    locked = false
  }

  function isOreName (n) {
    const s = String(n || '').toLowerCase()
    if (!s || s === 'air') return false
    if (s.endsWith('_ore')) return true
    if (s === 'ancient_debris') return true
    return false
  }

  function isTargetOre (n) {
    if (!isOreName(n)) return false
    if (!only) return true
    if (Array.isArray(only)) return only.some(tok => String(n).toLowerCase().includes(tok))
    return String(n).toLowerCase().includes(only)
  }

  function hasPickaxe () {
    try {
      const slots = bot.inventory?.items() || []
      const extra = []
      if (bot.heldItem) extra.push(bot.heldItem)
      const off = bot.inventory?.slots?.[45]; if (off) extra.push(off)
      for (const it of slots.concat(extra)) {
        const nm = String(it?.name || '').toLowerCase()
        if (nm.endsWith('_pickaxe')) return true
      }
      return false
    } catch { return false }
  }

  function pushVeinNeighbors (pos) {
    const V = require('vec3').Vec3
    const dirs = [new V(1,0,0), new V(-1,0,0), new V(0,1,0), new V(0,-1,0), new V(0,0,1), new V(0,0,-1)]
    for (const d of dirs) {
      const p = pos.plus(d)
      try { const b = bot.blockAt(p); if (b && isTargetOre(b.name)) stack.push(p) } catch {}
    }
  }

  async function ensureReachableForDig (block, timeoutMs = 6000, allowDig = true) {
    try {
      if (bot.canDigBlock && bot.canDigBlock(block)) return true
    } catch {}
    if (!ensurePathfinder()) return false
    try {
      const { goals, Movements } = pathfinder
      const mc = ensureMcData()
      const m = new Movements(bot, mc); m.canDig = !!allowDig; m.allowSprinting = true
      bot.pathfinder.setMovements(m)
      // Approach near the block (do not target occupying the ore's cell)
      bot.pathfinder.setGoal(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), true)
      const until = Date.now() + Math.max(1500, timeoutMs)
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 120))
        try { if (bot.canDigBlock && bot.canDigBlock(block)) break } catch {}
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      try { return bot.canDigBlock ? !!bot.canDigBlock(block) : true } catch { return true }
    } catch { return false }
  }

  function isAirName (n) {
    const s = String(n || '').toLowerCase()
    return s === 'air' || s === 'cave_air' || s === 'void_air'
  }

  function isTransparentName (n) {
    const s = String(n || '').toLowerCase()
    if (!s) return false
    if (isAirName(s)) return true
    if (s.includes('water')) return true
    return false
  }

  function neighborOffsets () {
    const V = require('vec3').Vec3
    return [new V(1,0,0), new V(-1,0,0), new V(0,1,0), new V(0,-1,0), new V(0,0,1), new V(0,0,-1)]
  }

  function findBlockingNeighbor (oreBlock) {
    try {
      const me = bot.entity?.position
      if (!me || !oreBlock) return null
      let best = null; let bestD = Infinity
      for (const d of neighborOffsets()) {
        const p = oreBlock.position.plus(d)
        const b = bot.blockAt(p)
        if (!b) continue
        const nm = String(b.name || '').toLowerCase()
        if (isAirName(nm)) continue
        if (isTargetOre(nm)) continue // never dig target ore as a cover
        // Prefer the neighbor closest to us
        const dist = p.distanceTo(me)
        if (dist < bestD) { best = b; bestD = dist }
      }
      return best
    } catch { return null }
  }

  function isOreExposed (oreBlock) {
    try {
      if (!oreBlock) return false
      for (const d of neighborOffsets()) {
        const b = bot.blockAt(oreBlock.position.plus(d))
        const nm = String(b?.name || '').toLowerCase()
        if (!b || isTransparentName(nm)) return true
      }
      return false
    } catch { return false }
  }

  function isFrontFaceClear (oreBlock) {
    try {
      if (!oreBlock || !bot.entity) return false
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
      const center = oreBlock.position.offset(0.5, 0.5, 0.5)
      const dx = center.x - eye.x
      const dy = center.y - eye.y
      const dz = center.z - eye.z
      const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz)
      let dir
      if (ax >= ay && ax >= az) dir = { x: Math.sign(dx), y: 0, z: 0 }
      else if (ay >= ax && ay >= az) dir = { x: 0, y: Math.sign(dy), z: 0 }
      else dir = { x: 0, y: 0, z: Math.sign(dz) }
      const facePos = oreBlock.position.offset(dir.x, dir.y, dir.z)
      const b = bot.blockAt(facePos)
      const nm = String(b?.name || '').toLowerCase()
      return (!b) || isTransparentName(nm)
    } catch { return false }
  }

  function frontCoverBlock (oreBlock) {
    try {
      if (!oreBlock || !bot.entity) return null
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
      const center = oreBlock.position.offset(0.5, 0.5, 0.5)
      const dx = center.x - eye.x
      const dy = center.y - eye.y
      const dz = center.z - eye.z
      const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz)
      let dir
      if (ax >= ay && ax >= az) dir = { x: Math.sign(dx), y: 0, z: 0 }
      else if (ay >= ax && ay >= az) dir = { x: 0, y: Math.sign(dy), z: 0 }
      else dir = { x: 0, y: 0, z: Math.sign(dz) }
      const pos = oreBlock.position.offset(dir.x, dir.y, dir.z)
      const b = bot.blockAt(pos)
      if (b) {
        const nm = String(b.name || '').toLowerCase()
        if (!isTransparentName(nm) && !isTargetOre(nm)) return b
      }
      return null
    } catch { return null }
  }

  function cursorBlock () {
    try { return bot.blockAtCursor ? (bot.blockAtCursor(6) || null) : null } catch { return null }
  }

  async function gotoNearAsync (pos, range = 1.5, allowDig = true, timeoutMs = 8000) {
    if (!ensurePathfinder()) return false
    const { goals, Movements } = pathfinder
    const mc = ensureMcData()
    const m = new Movements(bot, mc)
    m.canDig = !!allowDig
    m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    const goal = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(1, Math.floor(range)))
    try { await bot.pathfinder.goto(goal) } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    return true
  }

  async function digBlockAt (pos) {
    try {
      const ore = bot.blockAt(pos)
      if (!ore) return true
      // Approach near ore; allow pathfinder to dig through stone, but we dig ore ourselves
      await gotoNearAsync(ore.position, 1.5, true, 8000)
      // Equip appropriate tool and clear conflicting controls
      try { const ts = ensureToolSel(); await ts.ensureBestToolForBlock(bot, ore) } catch {}
      try {
        bot.setControlState('use', false); bot.setControlState('sneak', false)
        bot.setControlState('jump', false); bot.setControlState('forward', false)
        bot.setControlState('back', false); bot.setControlState('left', false); bot.setControlState('right', false)
      } catch {}
      // Face ore and try to dig via a visible face
      try { await bot.lookAt(ore.position.offset(0.5, 0.5, 0.5), true) } catch {}
      try {
        await bot.dig(ore, 'raycast')
      } catch (e) {
        const msg = String(e || '')
        if (/not in view/i.test(msg)) {
          // Find the nearest blocking block along the ray and remove it once
          try {
            const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
            const dst = ore.position.offset(0.5, 0.5, 0.5)
            const dir = dst.minus(eye).normalize()
            const hit = bot.world.raycast(eye, dir, Math.ceil(eye.distanceTo(dst)) + 1)
            const hp = hit && hit.position
            if (hp && !(hp.x === ore.position.x && hp.y === ore.position.y && hp.z === ore.position.z)) {
              const cover = bot.blockAt(hit.position)
              if (cover && !isAirName(cover.name) && !isTargetOre(cover.name)) {
                await gotoNearAsync(cover.position, 1.5, true, 6000)
                try { await bot.lookAt(cover.position.offset(0.5, 0.5, 0.5), true) } catch {}
                try { const ts2 = ensureToolSel(); await ts2.ensureBestToolForBlock(bot, cover) } catch {}
                try { await bot.dig(cover, 'raycast') } catch {}
                return false // next tick will retry the ore
              }
            }
          } catch {}
        }
        // Other errors: let next tick retry
        return false
      }
      // Successful dig: pickup nearby drops
      try { const acts = ensureActions(); if (acts) { await acts.run('pickup', { radius: 7, max: 32, timeoutMs: 1500, until: 'exhaust' }) } } catch {}
      return true
    } catch { return false }
  }

  function findNearestOre () {
    const me = bot.entity?.position
    if (!me) return null
    const found = bot.findBlocks({
      point: me, maxDistance: Math.max(4, radius), count: 48,
      matching: (b) => b && isTargetOre(b.name)
    }) || []
    if (!found.length) return null
    found.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    return found[0]
  }

  async function gotoNear (pos) {
    if (!ensurePathfinder()) return false
    const { Movements, goals } = pathfinder
    const mcd = ensureMcData()
    const m = new Movements(bot, mcd)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    const g = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), 1)
    bot.pathfinder.setGoal(g)
    return true
  }

  function randomExploreStep (step = 16) {
    try {
      const me = bot.entity?.position
      if (!me) return false
      if (!ensurePathfinder()) return false
      const { Movements, goals } = pathfinder
      const mcd = ensureMcData()
      const m = new Movements(bot, mcd)
      m.canDig = true; m.allowSprinting = true
      bot.pathfinder.setMovements(m)
      const angle = Math.random() * Math.PI * 2
      const dx = Math.round(Math.cos(angle) * step)
      const dz = Math.round(Math.sin(angle) * step)
      const tx = Math.floor(me.x + dx)
      const tz = Math.floor(me.z + dz)
      const ty = Math.floor(me.y)
      bot.pathfinder.setGoal(new goals.GoalNear(tx, ty, tz, 1), true)
      exploreUntil = Date.now() + 2500
      return true
    } catch { return false }
  }

  async function start () {
    mcData = ensureMcData()
    // mark as external to pause automations
    try { bot.emit('external:begin', { source: 'auto', tool: 'mine_ore' }) } catch {}
    lockHands()
    inited = true
  }

  async function cancel () { try { bot.emit('external:end', { source: 'auto', tool: 'mine_ore' }) } catch {} ; releaseHands() }
  async function pause () { /* no-op */ }
  async function resume () { /* no-op */ }

  async function tick () {
    if (!inited) await start()
    if (busy) return { status: 'running', progress: 0 }

    // Opportunistic auto-trash: keep space by dropping low-value blocks (no pathfinder usage)
    try {
      const now = Date.now()
      const slots = bot.inventory?.slots || []
      let free = 0; for (let i = 9; i < (slots.length || 45); i++) if (!slots[i]) free++
      if (free <= TRASH_MINFREE && (now - lastTrashAt) >= TRASH_COOLDOWN_MS) {
        const inv = bot.inventory?.items() || []
        const present = new Set(inv.map(it => String(it?.name || '').toLowerCase()))
        const want = TRASH.filter(n => present.has(n))
        if (want.length) {
          busy = true
          try { const acts = ensureActions(); if (acts) await acts.run('toss', { names: want }) } catch {}
          finally { busy = false; lastTrashAt = now }
          return { status: 'running', progress: 0, events: [{ type: 'auto_trash', names: want }] }
        }
      }
    } catch {}

    // If we had given up recently, fail
    if (gaveUpAt && Date.now() - gaveUpAt < 500) return { status: 'failed', progress: 0, events: [{ type: 'missing_target' }] }

    // Ensure we have a pickaxe at all
    if (!hasPickaxe()) { releaseHands(); return { status: 'failed', progress: 0, events: [{ type: 'missing_tool', tool: 'pickaxe' }] } }

    // If stack has ore positions, continue vein
    if (stack.length) {
      const pos = stack.pop()
      busy = true
      const ok = await digBlockAt(pos)
      busy = false
      if (ok) { pushVeinNeighbors(pos); return { status: 'running', progress: 0, events: [{ type: 'vein_progress' }] } }
    }

    // No stack: find nearest ore and path to it
    const found = findNearestOre()
    if (!found) {
      // No ore seen nearby: perform a short exploration step and keep running
      if (Date.now() < exploreUntil) return { status: 'running', progress: 0, events: [{ type: 'searching' }] }
      randomExploreStep(Math.min(32, Math.max(8, Math.floor(radius / 2))))
      return { status: 'running', progress: 0, events: [{ type: 'searching' }] }
    }
    // Always delegate approach+dig to digBlockAt (handles reachability)
    busy = true
    const ok = await digBlockAt(found)
    busy = false
    if (ok) { pushVeinNeighbors(found); return { status: 'running', progress: 0, events: [{ type: 'vein_start' }] } }
    return { status: 'running', progress: 0 }
  }

  return { start, tick, cancel, pause, resume }
}
