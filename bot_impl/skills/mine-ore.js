// Skill: mine_ore — scan for nearby ore veins and mine them.
// Intent-level: mines ores within a radius, performing simple vein-mining.

module.exports = function mineOreFactory ({ bot, args, log }) {
  const L = log
  const radius = Math.max(4, parseInt(args.radius || '32', 10))
  // Normalize 'only' filter: accept english tokens and common Chinese synonyms.
  function normalizeOnlyToken (s) {
    const v = String(s || '').toLowerCase().trim()
    if (!v) return null
    // Any/All
    if (v === 'any' || v === 'all' || v === 'ore' || v === '矿' || v === '矿物' || v === '随意' || v === '随意矿' || v === '随意矿物') return null
    // Chinese -> English mappings
    if (v === '煤' || v === '煤矿' || v === '煤炭') return 'coal'
    if (v === '铁' || v === '铁矿' || v === '生铁') return 'iron'
    if (v === '金' || v === '金矿') return 'gold'
    if (v === '铜' || v === '铜矿') return 'copper'
    if (v === '钻' || v === '钻石' || v === '钻矿') return 'diamond'
    if (v === '红石' || v === '红石矿') return 'redstone'
    if (v === '青金' || v === '青金石' || v === '青金矿' || v === '青金石矿') return 'lapis'
    if (v === '绿宝石' || v === '绿宝石矿') return 'emerald'
    if (v === '石英' || v === '石英矿') return 'quartz'
    if (v === '远古残骸' || v === '残骸' || v === '下界合金矿') return 'ancient_debris'
    // already english tokens like 'coal','iron', or full ids like 'diamond_ore'
    return v
  }

  function normalizeOnly (val) {
    if (!val) return null
    if (Array.isArray(val)) {
      const mapped = val.map(normalizeOnlyToken).filter(x => x !== undefined)
      // If array contains a null (meaning any), treat as no filter
      if (mapped.some(x => x === null)) return null
      return mapped
    }
    const t = normalizeOnlyToken(val)
    return t === null ? null : t
  }

  const only = normalizeOnly(args.only)
  const maxPerTick = 1
  let inited = false
  let target = null
  let stack = [] // vein DFS stack of positions (Vec3)
  const avoided = new Set() // positions of ore avoided due to hazards
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
    if (Array.isArray(only)) return only.some(tok => String(n).toLowerCase().includes(String(tok)))
    return String(n).toLowerCase().includes(String(only))
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
      const m = new Movements(bot, mc)
      m.canDig = !!allowDig
      m.allowSprinting = true
      // Allow default parkour/tower/scaffolding behavior
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

  function isLiquidName (n) {
    const s = String(n || '').toLowerCase()
    if (!s) return false
    return s.includes('water') || s.includes('lava')
  }

  function isSolidName (n) {
    const s = String(n || '').toLowerCase()
    if (!s) return false
    if (isAirName(s)) return false
    if (isLiquidName(s)) return false
    return true
  }

  function isSafeStandFeet (feetPos) {
    try {
      const feet = bot.blockAt(feetPos)
      const head = bot.blockAt(feetPos.offset(0, 1, 0))
      const under = bot.blockAt(feetPos.offset(0, -1, 0))
      const feetOk = (!feet || isAirName(feet.name))
      const headOk = (!head || isAirName(head.name))
      const underOk = (!!under && isSolidName(under.name))
      if (!feetOk || !headOk || !underOk) return false
      // avoid standing where below-under is liquid or air (steep fall risk after digging underfoot)
      const belowUnder = bot.blockAt(feetPos.offset(0, -2, 0))
      if (!belowUnder) return true
      const bn = String(belowUnder.name || '').toLowerCase()
      if (isLiquidName(bn)) return false
      return true
    } catch { return false }
  }

  function findSideStandForOre (oreBlock) {
    try {
      if (!oreBlock) return null
      const me = bot.entity?.position
      const V = require('vec3').Vec3
      const dirs = [new V(1,0,0), new V(-1,0,0), new V(0,0,1), new V(0,0,-1)]
      let best = null; let bestD = Infinity
      for (const d of dirs) {
        const stand = oreBlock.position.plus(d)
        // We stand with feet at 'stand' (requires two-block air and solid under)
        if (!isSafeStandFeet(stand)) continue
        const dd = me ? stand.distanceTo(me) : 0
        if (dd < bestD) { best = stand; bestD = dd }
      }
      return best
    } catch { return null }
  }

  function isFallingBlockName (n) {
    try {
      const s = String(n || '').toLowerCase()
      if (!s) return false
      if (s === 'sand' || s === 'red_sand' || s === 'gravel') return true
      if (s.endsWith('_concrete_powder')) return true
      if (s === 'anvil' || s === 'chipped_anvil' || s === 'damaged_anvil') return true
      return false
    } catch { return false }
  }

  function posKey (p) { return `${p?.x}|${p?.y}|${p?.z}` }

  function liquidNeighbor (oreBlock) {
    try {
      if (!oreBlock) return null
      for (const d of neighborOffsets()) {
        const p = oreBlock.position.plus(d)
        const b = bot.blockAt(p)
        const nm = String(b?.name || '').toLowerCase()
        if (isLiquidName(nm)) return { type: nm.includes('lava') ? 'lava' : 'water', pos: p }
      }
      return null
    } catch { return null }
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

  function explosionCooling () {
    try { const t = (bot.state && bot.state.explosionCooldownUntil) || 0; return Date.now() < t } catch { return false }
  }

  async function gotoNearAsync (pos, range = 1.5, allowDig = true, timeoutMs = 8000) {
    if (!ensurePathfinder()) return false
    const { goals, Movements } = pathfinder
    const mc = ensureMcData()
    const m = new Movements(bot, mc)
    m.canDig = !!allowDig
    m.allowSprinting = true
    // Allow default parkour/tower/scaffolding behavior
    bot.pathfinder.setMovements(m)
    const goal = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(1, Math.floor(range)))
    try { await bot.pathfinder.goto(goal) } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    return true
  }

  async function digBlockAt (pos) {
    try {
      if (explosionCooling()) return false
      const ore = bot.blockAt(pos)
      if (!ore) return true
      // Do not dig a block directly under our feet; reposition to a safe side first
      try {
        const meFeet = bot.entity?.position?.floored?.() || bot.entity?.position
        if (meFeet) {
          const underFeet = meFeet.offset(0, -1, 0)
          const standingOnOre = (underFeet.x === ore.position.x && underFeet.y === ore.position.y && underFeet.z === ore.position.z)
          if (standingOnOre) {
            const side = findSideStandForOre(ore)
            if (side) { await gotoNearAsync(side, 0.5, true, 6000) }
            return false
          }
        }
      } catch {}
      // Ceiling hazard handling
      try {
        const above = bot.blockAt(ore.position.offset(0, 1, 0))
        const an = String(above?.name || '').toLowerCase()
        if (isLiquidName(an)) {
          // liquids above: still avoid (risk of flooding)
          avoided.add(posKey(ore.position))
          try { L && L.info && L.info('avoid ore due to liquid above', an, 'at', `${ore.position.x},${ore.position.y},${ore.position.z}`) } catch {}
          try { bot.emit('mine_ore:hazard', { type: 'ceiling', above: an, ore: ore.position }) } catch {}
          return false
        } else if (isFallingBlockName(an)) {
          // gravel/sand above: try to clear it safely from the side instead of avoiding the ore entirely
          try {
            const side = findSideStandForOre(ore)
            if (side) { await gotoNearAsync(side, 0.7, true, 6000) }
            try { await bot.lookAt(above.position.offset(0.5, 0.5, 0.5), true) } catch {}
            try { const ts = ensureToolSel(); await ts.ensureBestToolForBlock(bot, above) } catch {}
            try { await bot.dig(above, 'raycast') } catch {}
          } catch {}
          // Let next tick retry the ore after cover clears/falls
          return false
        }
      } catch {}
      // If ore is hanging (air/liquid below), avoid standing on it to dig from top; prefer side stand
      try {
        const below = bot.blockAt(ore.position.offset(0, -1, 0))
        const bn = String(below?.name || '').toLowerCase()
        if (!below || isAirName(bn) || isLiquidName(bn)) {
          const meFeet = bot.entity?.position?.floored?.() || bot.entity?.position
          if (meFeet && meFeet.y === ore.position.y + 1) {
            const side = findSideStandForOre(ore)
            if (side) { await gotoNearAsync(side, 0.5, true, 6000); return false }
          }
        }
      } catch {}
      // Basic liquid hazard avoidance: skip ores adjacent to water/lava
      const hazard = liquidNeighbor(ore)
      if (hazard) {
        avoided.add(posKey(ore.position))
        try { L && L.info && L.info('avoid ore due to liquid', hazard.type, 'at', hazard.pos && `${hazard.pos.x},${hazard.pos.y},${hazard.pos.z}`) } catch {}
        try { bot.emit('mine_ore:hazard', { type: 'liquid', liquid: hazard.type, ore: ore.position }) } catch {}
        return false
      }
      // Approach near ore; allow pathfinder to dig through stone, but we dig ore ourselves
      await gotoNearAsync(ore.position, 1.5, true, 8000)
      // Re-check after approach: avoid digging underfoot
      try {
        const meFeet = bot.entity?.position?.floored?.() || bot.entity?.position
        if (meFeet) {
          const underFeet = meFeet.offset(0, -1, 0)
          const standingOnOre = (underFeet.x === ore.position.x && underFeet.y === ore.position.y && underFeet.z === ore.position.z)
          if (standingOnOre) {
            const side = findSideStandForOre(ore)
            if (side) { await gotoNearAsync(side, 0.5, true, 6000); return false }
          }
        }
      } catch {}
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
                // If the cover is liquid, avoid this ore entirely
                if (isLiquidName(cover.name)) {
                  avoided.add(posKey(ore.position))
                  try { bot.emit('mine_ore:hazard', { type: 'liquid', liquid: cover.name, ore: ore.position }) } catch {}
                  return false
                }
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
    for (const p of found) { if (!avoided.has(posKey(p))) return p }
    return null
  }

  async function gotoNear (pos) {
    if (!ensurePathfinder()) return false
    const { Movements, goals } = pathfinder
    const mcd = ensureMcData()
    const m = new Movements(bot, mcd)
    m.canDig = true
    m.allowSprinting = true
    // Allow default parkour/tower/scaffolding behavior
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
      m.canDig = true
      m.allowSprinting = true
      // Allow default parkour/tower/scaffolding behavior
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
    if (explosionCooling()) return { status: 'running', progress: 0, events: [{ type: 'cooldown', reason: 'explosion' }] }

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
      if (avoided.has(posKey(pos))) {
        return { status: 'running', progress: 0, events: [{ type: 'skipped_hazard' }] }
      }
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
