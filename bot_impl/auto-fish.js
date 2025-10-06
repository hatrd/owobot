// Auto-fishing: if inventory has a fishing rod and nearby water is present,
// move to a valid shore and fish in a loop. Respects externalBusy to yield to higher-priority actions.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const L = log || { info: (...a) => console.log('[FISH]', ...a), debug: (...a) => dlog && dlog(...a), warn: (...a) => console.warn('[FISH]', ...a) }

  const S = state.autoFish = state.autoFish || {}
  const cfg = S.cfg = Object.assign({ enabled: true, tickMs: 8000, radius: 10, debug: false }, S.cfg || {})

  let timer = null
  let running = false
  let session = null
  let fishingBusy = false

  function hasFishingRod () {
    try { return (bot.inventory?.items() || []).some(it => String(it?.name || '').toLowerCase() === 'fishing_rod') } catch { return false }
  }

  function isNearbyWater (pos, r = 8) {
    try {
      const list = bot.findBlocks({
        matching: (b) => {
          if (!b) return false
          const n = String(b.name || '').toLowerCase()
          if (n.includes('water')) return true
          // waterlogged support (basic): some blocks expose getProperties().waterlogged
          try { const p = b.getProperties && b.getProperties(); if (p && p.waterlogged === true) return true } catch {}
          return false
        },
        maxDistance: Math.max(2, r),
        count: 50
      }) || []
      if (cfg.debug) L.info('scan water count=', list.length, 'radius=', r)
      return list.length > 0
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
        matching: (b) => {
          if (!b) return false
          const n = String(b.name || '').toLowerCase()
          if (n === 'water') return true
          try { const p = b.getProperties && b.getProperties(); if (p && p.waterlogged === true) return true } catch {}
          return false
        },
        maxDistance: Math.max(3, r),
        count: 100
      }) || []
      if (!waterBlocks.length) return null
      // For each water block, find an adjacent standable position (4-neighborhood)
      const { Vec3 } = require('vec3')
      let best = null; let bestD = Infinity
      for (const wb of waterBlocks) {
        const adj = [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)].map(d => wb.offset(d.x, 0, d.z))
        for (const p of adj) {
          if (!canStandOn(p)) continue
          const d = p.offset(0,1,0).distanceTo(me)
          if (d < bestD) { best = p; bestD = d }
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
    session = (async () => {
      try {
        // suspend auto-look and hand-equip clobber during fishing
        try { if (state) { state.autoLookSuspended = true; state.holdItemLock = 'fishing_rod'; state.isFishing = true } } catch {}
        // preconditions
        if (!hasFishingRod()) { if (cfg.debug) L.info('skip: no rod'); return }
        const me = bot.entity?.position; if (!me) { if (cfg.debug) L.info('skip: not ready'); return }
        if (!isNearbyWater(me, cfg.radius)) { if (cfg.debug) L.info('skip: no water nearby'); return }
        // Move to a valid shore if not already adjacent
        const spot = findFishingSpot(cfg.radius)
        if (!spot) { if (cfg.debug) L.info('skip: no shoreline spot'); return }
        await goto(spot, 0)
        // Equip rod and fish loop until preconditions break
        const ok = await ensureRodEquipped(); if (!ok) { if (cfg.debug) L.info('equip failed'); return }
        while (cfg.enabled) {
          if (state.externalBusy) break
          if (!hasFishingRod()) break
          const here = bot.entity?.position; if (!here) break
          if (!isNearbyWater(here, 3)) { if (cfg.debug) L.info('stop: water no longer nearby'); break }
          // keep rod in hand in case other modules changed it
          await ensureRodEquipped()
          // orient to nearest water to reduce immediate cancels due to ground
          try {
            const { Vec3 } = require('vec3')
            const blocks = bot.findBlocks({ matching: b => b && String(b.name||'').toLowerCase().includes('water'), maxDistance: 5, count: 20 }) || []
            if (blocks.length) {
              const me = bot.entity?.position
              blocks.sort((a,b)=>a.distanceTo(me)-b.distanceTo(me))
              const aim = blocks[0].offset(0, 0, 0)
              try { await bot.lookAt(aim.offset(0.5, 0.4, 0.5), true) } catch {}
            }
          } catch {}
          const okFish = await fishOnce()
          // if fish cancelled immediately, add small backoff to avoid rapid retry storm
          await new Promise(r => setTimeout(r, okFish ? 300 : 700))
        }
      } finally {
        try { if (state) { state.holdItemLock = null; state.autoLookSuspended = false; state.isFishing = false } } catch {}
        session = null
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
  on('agent:stop_all', () => { /* no-op; session loop checks externalBusy */ })
  registerCleanup && registerCleanup(() => { stop() })

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
