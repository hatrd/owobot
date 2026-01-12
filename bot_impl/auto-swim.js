// Auto-swim: if the bot is in water, hold jump to float/swim up

const { ensurePathfinder: ensurePathfinderForBot } = require('./lib/pathfinder')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const L = log || { info: (...a) => console.log('[SWIM]', ...a), debug: (...a) => dlog && dlog(...a) }

  const S = state.autoSwim = state.autoSwim || {}
  const cfg = S.cfg = Object.assign({ enabled: true, tickMs: 120, debug: false, forceSurfaceMs: 600, scanUp: 12, holdMs: 1200 }, S.cfg || {})

  let timer = null
  let jumping = false

  function isWaterName (n) { const s = String(n || '').toLowerCase(); return s.includes('water') || s.includes('bubble_column') }
  function blockInfo (p) {
    try {
      const b = bot.blockAt(p)
      const name = String(b?.name || '')
      let wl = false
      try { const pr = b?.getProperties && b.getProperties(); if (pr && pr.waterlogged) wl = true } catch {}
      return { name, waterlogged: wl }
    } catch { return { name: '?', waterlogged: false } }
  }

  function isHeadSubmerged () {
    try {
      if (!bot.entity || !bot.entity.position) return false
      const pos = bot.entity.position.floored()
      const head = bot.blockAt(pos.offset(0, 1, 0))
      const headW = head && isWaterName(head.name)
      let wl = false
      try { const p = head?.getProperties && head.getProperties(); if (p && p.waterlogged) wl = true } catch {}
      return headW || wl
    } catch { return false }
  }

  function feetInWater () {
    try {
      const pos = bot.entity.position.floored()
      const feet = bot.blockAt(pos)
      const feetW = feet && isWaterName(feet.name)
      let wl = false
      try { const p = feet?.getProperties && feet.getProperties(); if (p && p.waterlogged) wl = true } catch {}
      return feetW || wl
    } catch { return false }
  }

  function setJump (v, reason = '') {
    try {
      if (v && !jumping) { bot.setControlState('jump', true); jumping = true; if (cfg.debug) console.log('[SWIM] setJump -> ON reason=', reason) }
      if (!v && jumping) { bot.setControlState('jump', false); jumping = false; if (cfg.debug) console.log('[SWIM] setJump -> OFF') }
    } catch {}
  }

  let submergedSince = 0
  let surfaceGoalUntil = 0
  let lateralGoalUntil = 0

  function ensurePathfinder () {
    return ensurePathfinderForBot(bot)
  }

  function isAir (b) { try { return !b || String(b.name || '').toLowerCase() === 'air' } catch { return false } }
  function isBreathableAt (p) {
    try {
      const feet = bot.blockAt(p)
      const head = bot.blockAt(p.offset(0, 1, 0))
      return isAir(head)
    } catch { return false }
  }
  function findNearestAir (range = 8) {
    try {
      if (!bot.entity || !bot.entity.position) return null
      const V = require('vec3').Vec3
      const base = bot.entity.position.floored()
      const r = Math.max(2, range)
      let best = null; let bestD = Infinity
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -1; dy <= 3; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            const q = new V(base.x + dx, base.y + dy, base.z + dz)
            if (!isBreathableAt(q)) continue
            const d = q.distanceTo(base)
            if (d < bestD) { best = q; bestD = d }
          }
        }
      }
      return best
    } catch { return null }
  }

  async function tick () {
    if (!cfg.enabled) { setJump(false); return }
    // Respect external actions/hand locks to avoid interrupting precise tasks (e.g., mining)
    try { if (state?.externalBusy || state?.holdItemLock) { setJump(false); return } } catch {}
    if (!bot.entity || !bot.entity.position) return
    // If mounted or sleeping, ignore
    if (bot.isSleeping || bot.vehicle) { setJump(false); return }
    const headInWater = isHeadSubmerged()
    const feetW = feetInWater()
    const inWater = headInWater || feetW
    const hasGoal = !!(bot.pathfinder && bot.pathfinder.goal)
    // Non-intrusive: when pathfinder has an active goal, we avoid overriding controls except for brief anti-drown pulses
    if (!hasGoal) {
      setJump(inWater, headInWater ? 'head' : (feetW ? 'feet' : ''))
    } else {
      // When following a path, only assist if head is submerged for a while
      if (headInWater && submergedSince && (Date.now() - submergedSince) >= Math.max(400, cfg.forceSurfaceMs)) setJump(true, 'assist-goal')
      else setJump(false)
    }
    if (cfg.debug) {
      try {
        const pos = bot.entity.position.floored()
        const infoH = blockInfo(pos.offset(0, 1, 0))
        const infoF = blockInfo(pos)
        const vy = Number(bot.entity?.velocity?.y || 0).toFixed(3)
        console.log('[SWIM]', (Date.now() % 100000), 'pos=', pos.x, pos.y, pos.z,
          'vy=', vy,
          'head=', infoH.name, 'wlH=', infoH.waterlogged,
          'feet=', infoF.name, 'wlF=', infoF.waterlogged,
          'headIn=', headInWater, 'feetIn=', feetW,
          'jump=', jumping, 'sneak=', !!(bot.controlState && bot.controlState.sneak))
      } catch {}
    }
    // ensure not sneaking while trying to float (only when not navigating)
    try { if (inWater && !hasGoal) bot.setControlState('sneak', false) } catch {}
    const now = Date.now()
    // emergency assist: when idle in water and sinking, gently look up
    try {
      const vy = Number(bot.entity?.velocity?.y || 0)
      if (!hasGoal && inWater && vy <= 0 && now >= surfaceGoalUntil) {
        if (!state?.isFishing) { try { await bot.lookAt(bot.entity.position.offset(0, 1.0, 0), true) } catch {} }
      }
    } catch {}
    if (headInWater) {
      if (!submergedSince) submergedSince = now
      // If submerged for a while, try to push a short surface goal straight up
      if (!hasGoal && (now - submergedSince) >= cfg.forceSurfaceMs && now >= surfaceGoalUntil) {
        const base = bot.entity.position.floored()
        let targetY = null
        for (let dy = 2; dy <= Math.max(2, cfg.scanUp); dy++) {
          try {
            const head = bot.blockAt(base.offset(0, dy, 0))
            if (!head || String(head.name||'').toLowerCase() === 'air') { targetY = base.y + dy; break }
          } catch {}
        }
        const pf = ensurePathfinder()
        if (pf && targetY != null && !hasGoal) {
          try {
            const { goals } = pf
            bot.pathfinder.setGoal(new goals.GoalNear(base.x, targetY, base.z, 0), true)
            surfaceGoalUntil = now + 1500
            if (cfg.debug) console.log('[SWIM] surfaceGoal ->', base.x, targetY, base.z, 'scanUp=', cfg.scanUp)
          } catch {}
        } else if (cfg.debug) {
          console.log('[SWIM] surfaceGoal none, topBlocked, scanUp=', cfg.scanUp)
        }
      }
      // If still submerged and upward path blocked, try lateral nearest air pocket
      if (!hasGoal && (now - submergedSince) >= (cfg.forceSurfaceMs + 300) && now >= lateralGoalUntil) {
        const pf = ensurePathfinder()
        const spot = findNearestAir(8)
        if (pf && spot && !hasGoal) {
          try {
            const { goals } = pf
            bot.pathfinder.setGoal(new goals.GoalNear(spot.x, spot.y, spot.z, 0), true)
            lateralGoalUntil = now + 1600
            if (cfg.debug) console.log('[SWIM] lateralGoal ->', spot.x, spot.y, spot.z)
          } catch {}
        }
      }
    } else {
      submergedSince = 0
      surfaceGoalUntil = 0
      lateralGoalUntil = 0
    }
    if (cfg.debug) {
      try { console.log('[SWIM] goal=', !!(bot.pathfinder && bot.pathfinder.goal), 'until=', Math.max(0, surfaceGoalUntil - Date.now())) } catch {}
    }
  }

  function start () { if (!timer) timer = setInterval(() => { tick().catch(()=>{}) }, Math.max(120, cfg.tickMs)) }
  function stop () { if (timer) { try { clearInterval(timer) } catch {} ; timer = null; setJump(false) } }

  on('spawn', start)
  if (state?.hasSpawned) start()
  // Start immediately on install as well (guarded)
  start()
  on('end', stop)
  on('agent:stop_all', () => { setJump(false); submergedSince = 0; surfaceGoalUntil = 0 })
  registerCleanup && registerCleanup(() => { stop() })

  // CLI: .swim on|off|status|interval ms|debug on|off|surface ms|scanup N|hold ms
  on('cli', ({ cmd, args }) => {
    if (String(cmd||'').toLowerCase() !== 'swim') return
    const sub = String(args[0]||'').toLowerCase()
    const val = String(args[1]||'')
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[SWIM] enabled'); break
      case 'off': cfg.enabled = false; setJump(false); console.log('[SWIM] disabled'); break
      case 'status': console.log('[SWIM] enabled=', cfg.enabled, 'tickMs=', cfg.tickMs, 'forceSurfaceMs=', cfg.forceSurfaceMs, 'scanUp=', cfg.scanUp, 'holdMs=', cfg.holdMs, 'debug=', cfg.debug); break
      case 'interval': cfg.tickMs = Math.max(120, parseInt(val||'220', 10)); console.log('[SWIM] tickMs=', cfg.tickMs); break
      case 'debug': cfg.debug = (val.toLowerCase() !== 'off'); console.log('[SWIM] debug=', cfg.debug); break
      case 'surface': cfg.forceSurfaceMs = Math.max(200, parseInt(val||'900', 10)); console.log('[SWIM] forceSurfaceMs=', cfg.forceSurfaceMs); break
      case 'scanup': cfg.scanUp = Math.max(2, parseInt(val||'8', 10)); console.log('[SWIM] scanUp=', cfg.scanUp); break
      case 'hold': cfg.holdMs = Math.max(100, parseInt(val||'1200', 10)); console.log('[SWIM] holdMs=', cfg.holdMs); break
      default: console.log('[SWIM] usage: .swim on|off|status|interval ms|debug on|off')
    }
  })
}

module.exports = { install }
