// Auto-fishing: if inventory has a fishing rod and nearby water is present,
// move to a valid shore and fish in a loop. Respects externalBusy to yield to higher-priority actions.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const L = log || { info: (...a) => console.log('[FISH]', ...a), debug: (...a) => dlog && dlog(...a), warn: (...a) => console.warn('[FISH]', ...a) }
  const { Vec3 } = require('vec3')
  const WATER_ADJ_OFFSETS = [new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  const MAX_WATER_SCAN_DEPTH = 3

  const S = state.autoFish = state.autoFish || {}
  const cfg = S.cfg = Object.assign({ enabled: true, tickMs: 8000, radius: 10, debug: false }, S.cfg || {})
  // Generation token to invalidate old sessions across hot-reload or resets
  S.gen = (S.gen || 0) + 1
  const GEN = S.gen

  let timer = null
  let running = false
  let session = null
  let fishingBusy = false
  let waterBelowDetected = false

  function floorVec (pos) {
    if (!pos) return null
    if (typeof pos.floored === 'function') return pos.floored()
    return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  }

  function isWaterBlock (block) {
    if (!block) return false
    const n = String(block.name || '').toLowerCase()
    if (n.includes('water') || n.includes('bubble_column')) return true
    try {
      const props = block.getProperties && block.getProperties()
      if (props && props.waterlogged === true) return true
    } catch {}
    return false
  }

  function hasWaterBelow (pos, depth = MAX_WATER_SCAN_DEPTH) {
    try {
      const base = floorVec(pos)
      if (!base) return false
      const max = Math.max(1, depth)
      for (let d = 1; d <= max; d++) {
        const block = bot.blockAt(base.offset(0, -d, 0))
        if (isWaterBlock(block)) return true
      }
      return false
    } catch { return false }
  }

  function hasAdjacentWaterColumn (ground, depth = MAX_WATER_SCAN_DEPTH) {
    try {
      const base = ground?.clone ? ground.clone() : floorVec(ground)
      if (!base) return false
      const max = Math.max(0, depth)
      for (const dir of WATER_ADJ_OFFSETS) {
        for (let drop = 0; drop <= max; drop++) {
          if (dir.x === 0 && dir.z === 0 && drop === 0) continue
          const target = base.offset(dir.x, 0, dir.z).offset(0, -drop, 0)
          const block = bot.blockAt(target)
          if (isWaterBlock(block)) return true
        }
      }
      return false
    } catch { return false }
  }

  function hasFishingRod () {
    try { return (bot.inventory?.items() || []).some(it => String(it?.name || '').toLowerCase() === 'fishing_rod') } catch { return false }
  }

  function isNearbyWater (pos, r = 8) {
    try {
      if (hasWaterBelow(pos, MAX_WATER_SCAN_DEPTH)) {
        if (!waterBelowDetected && cfg.debug) L.info('water detected below feet (<=3 blocks)')
        waterBelowDetected = true
        return true
      }
      if (waterBelowDetected) waterBelowDetected = false
      const list = bot.findBlocks({
        matching: (b) => isWaterBlock(b),
        maxDistance: Math.max(2, r),
        count: 50
      }) || []
      if (cfg.debug) L.info('scan water count=', list.length, 'radius=', r)
      return list.length > 0
    } catch { return false }
  }

  function feetInWater () {
    try {
      const p = bot.entity?.position?.floored?.()
      if (!p) return false
      const feet = bot.blockAt(p)
      const head = bot.blockAt(p.offset(0, 1, 0))
      return isWaterBlock(feet) || isWaterBlock(head)
    } catch { return false }
  }

  function ensurePathfinder () {
    try {
      const pf = require('mineflayer-pathfinder')
      if (!bot.pathfinder) bot.loadPlugin(pf.pathfinder)
      const mcData = bot.mcData || require('minecraft-data')(bot.version)
      const m = new pf.Movements(bot, mcData)
      m.canDig = false; m.allowSprinting = true; m.allowParkour = false; m.allow1by1towers = false
      bot.pathfinder.setMovements(m)
      return pf
    } catch (e) { L.warn('pathfinder missing:', e?.message || e); return null }
  }

  // Treat p as the ground block coordinate we want to stand on
  function canStandOn (p) {
    try {
      const ground = bot.blockAt(p)
      if (!ground) return false
      const gname = String(ground.name || '').toLowerCase()
      if (!gname || gname === 'air' || gname.includes('water') || gname.includes('lava')) return false
      const feet = bot.blockAt(p.offset(0, 1, 0))
      const head = bot.blockAt(p.offset(0, 2, 0))
      const feetEmpty = (!feet || String(feet.name || '') === 'air')
      const headEmpty = (!head || String(head.name || '') === 'air')
      return feetEmpty && headEmpty
    } catch { return false }
  }

  function findFishingSpot (r = 10) {
    try {
      const me = bot.entity?.position; if (!me) return null
      const waterBlocks = bot.findBlocks({
        matching: (b) => isWaterBlock(b),
        maxDistance: Math.max(3, r),
        count: 100
      }) || []
      if (!waterBlocks.length) return null
      // For each water block, find an adjacent standable position (cardinals + vertical tolerance)
      let best = null; let bestD = Infinity
      for (const wb of waterBlocks) {
        for (const dir of WATER_ADJ_OFFSETS) {
          for (let rise = 0; rise <= MAX_WATER_SCAN_DEPTH; rise++) {
            if (dir.x === 0 && dir.z === 0 && rise === 0) continue
            const ground = new Vec3(wb.x + dir.x, wb.y + rise, wb.z + dir.z)
            if (!canStandOn(ground)) continue
            if (!hasAdjacentWaterColumn(ground, MAX_WATER_SCAN_DEPTH)) continue
            const d = ground.offset(0, 1, 0).distanceTo(me)
            if (d < bestD) { best = ground; bestD = d }
          }
        }
      }
      if (cfg.debug) L.info('spot ->', best ? `${best.x},${best.y},${best.z}` : 'none')
      return best
    } catch { return null }
  }

  async function goto (groundPos, range = 0) {
    const pf = ensurePathfinder(); if (!pf) return false
    const { goals } = pf
    try {
      const dest = groundPos.offset(0, 1, 0) // stand with feet above ground block
      bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, Math.max(0, range)), true)
      const until = Date.now() + 8000
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 80))
        if (!bot.pathfinder?.isMoving?.()) break
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      return true
    } catch { return false }
  }

  async function ensureRodEquipped () {
    try {
      // already in hand
      if (bot.heldItem && String(bot.heldItem.name || '').toLowerCase() === 'fishing_rod') return true
      // offhand
      const off = bot.inventory?.slots?.[45]
      if (off && String(off.name || '').toLowerCase() === 'fishing_rod') {
        try { await bot.equip(off, 'hand'); if (cfg.debug) L.info('equip <- offhand') ; return true } catch {}
      }
      // inventory (any slot)
      const it = (bot.inventory?.items() || []).find(x => String(x?.name || '').toLowerCase() === 'fishing_rod')
      if (!it) return false
      await bot.equip(it, 'hand')
      if (cfg.debug) L.info('equip -> fishing_rod')
      return true
    } catch { return false }
  }

  async function fishOnce () {
    try {
      // prevent overlapping fish() calls across any code path
      const start = Date.now()
      while (fishingBusy) { await new Promise(r => setTimeout(r, 60)); if (Date.now() - start > 3000) break }
      fishingBusy = true
      if (cfg.debug) L.info('fish() begin')
      await bot.fish()
      if (cfg.debug) L.info('fish() done')
      fishingBusy = false
      return true
    } catch (e) {
      if (cfg.debug) L.info('fish error:', e?.message || e)
      fishingBusy = false
      // backoff a bit if reentry error
      if (/again/i.test(String(e))) {
        // Ensure any previous cast is cancelled/retracted
        try { bot.activateItem() } catch {}
        await new Promise(r => setTimeout(r, 900))
      } else {
        await new Promise(r => setTimeout(r, 400))
      }
      return false
    }
  }

  async function runSession () {
    if (session) return
    // prevent cross-reload overlap: shared flag
    if (S.running) return
    S.running = true
    session = (async () => {
      try {
        try { if (state) state.currentTask = { name: 'auto_fish', source: 'auto', startedAt: Date.now() } } catch {}
        // suspend auto-look and hand-equip clobber during fishing
        try { if (state) { state.autoLookSuspended = true; state.holdItemLock = 'fishing_rod'; state.isFishing = true } } catch {}
        // preconditions
        if (S.gen !== GEN) return
        if (!hasFishingRod()) { if (cfg.debug) L.info('skip: no rod'); return }
        const me = bot.entity?.position; if (!me) { if (cfg.debug) L.info('skip: not ready'); return }
        if (!isNearbyWater(me, cfg.radius)) { if (cfg.debug) L.info('skip: no water nearby'); return }
        // Move to a valid shore if not already adjacent
        const spot = findFishingSpot(cfg.radius)
        if (!spot) { if (cfg.debug) L.info('skip: no shoreline spot'); return }
        await goto(spot, 0)
        // Ensure we stand on dry block (not in water). If feet in water, nudge to nearest standable
        if (feetInWater()) {
          const base = spot.clone ? spot.clone() : spot
          const cand = [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)]
          let moved = false
          for (const d of cand) {
            const p = base.offset(d.x, 0, d.z)
            if (!canStandOn(p)) continue
            await goto(p, 0)
            if (!feetInWater()) { moved = true; break }
          }
          if (!moved) {
            const alt = findFishingSpot(Math.max(6, cfg.radius + 4))
            if (alt) await goto(alt, 0)
          }
        }
        // Equip rod and fish loop until preconditions break
        const ok = await ensureRodEquipped(); if (!ok) { if (cfg.debug) L.info('equip failed'); return }
        while (cfg.enabled && S.gen === GEN) {
          if (state.externalBusy) break
          if (!hasFishingRod()) break
          const here = bot.entity?.position; if (!here) break
          if (!isNearbyWater(here, 3)) { if (cfg.debug) L.info('stop: water no longer nearby'); break }
          // keep rod in hand in case other modules changed it
          await ensureRodEquipped()
          // orient to nearest water to reduce immediate cancels due to ground
          try {
            const blocks = bot.findBlocks({ matching: b => isWaterBlock(b), maxDistance: 5, count: 20 }) || []
            if (blocks.length) {
              const me = bot.entity?.position
              blocks.sort((a,b)=>a.distanceTo(me)-b.distanceTo(me))
              const aim = blocks[0].offset(0, 0, 0)
              try { await bot.lookAt(aim.offset(0.5, 0.4, 0.5), true) } catch {}
            }
          } catch {}
          if (S.gen !== GEN) break
          const okFish = await fishOnce()
          // if fish cancelled immediately, add small backoff to avoid rapid retry storm
          await new Promise(r => setTimeout(r, okFish ? 300 : 700))
        }
      } finally {
        try { if (state && state.currentTask && state.currentTask.name === 'auto_fish') state.currentTask = null } catch {}
        try { if (state) { state.holdItemLock = null; state.autoLookSuspended = false; state.isFishing = false } } catch {}
        session = null
        S.running = false
      }
    })()
    await session
  }

  async function tick () {
    if (!cfg.enabled) return
    if (running) return
    if (state.externalBusy) return
    if (bot.currentWindow) return
    running = true
    try { await runSession() } finally { running = false }
  }

  function start () { if (!timer) timer = setInterval(() => { tick().catch(()=>{}) }, Math.max(1500, cfg.tickMs)) }
  function stop () { if (timer) { try { clearInterval(timer) } catch {} ; timer = null } }

  on('spawn', start)
  if (state?.hasSpawned) start()
  // Start immediately on install to be hot-reload safe
  start()
  on('end', stop)
  on('agent:stop_all', () => { try { S.gen++; if (cfg.debug) L.info('invalidate gen ->', S.gen); try { bot.activateItem() } catch {} } catch {} })
  // Resume fishing after external actions that might have interrupted it
  on('external:end', () => { if (cfg.enabled && !running && !session) setTimeout(() => { runSession().catch(()=>{}) }, 300) })
  on('autofish:now', () => { runSession().catch(() => {}) })
  registerCleanup && registerCleanup(() => { try { S.gen++ } catch {}; stop() })

  // CLI: .autofish on|off|status|interval ms|radius N|debug on|off
  on('cli', ({ cmd, args }) => {
    if (String(cmd || '').toLowerCase() !== 'autofish') return
    const sub = (args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[FISH] enabled'); break
      case 'off': cfg.enabled = false; console.log('[FISH] disabled'); break
      case 'status': console.log('[FISH] enabled=', cfg.enabled, 'tickMs=', cfg.tickMs, 'radius=', cfg.radius, 'debug=', cfg.debug, 'running=', running, 'session=', Boolean(session)); break
      case 'interval': cfg.tickMs = Math.max(1000, parseInt(val || '8000', 10)); console.log('[FISH] tickMs=', cfg.tickMs); break
      case 'radius': cfg.radius = Math.max(3, parseInt(val || '10', 10)); console.log('[FISH] radius=', cfg.radius); break
      case 'debug': cfg.debug = (String(val || 'on').toLowerCase() !== 'off'); console.log('[FISH] debug=', cfg.debug); break
      case 'now': (async () => { try { await runSession() } catch {} })(); break
      default: console.log('[FISH] usage: .autofish on|off|status|interval ms|radius N|debug on|off')
    }
  })
}

module.exports = { install }
