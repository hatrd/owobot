// Random walk to mimic a casual player when idle (AI-independent)

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  const S = state.randomWalk = state.randomWalk || {}
  const cfg = S.cfg = Object.assign({
    enabled: true,
    radius: 6,
    intervalMs: 4000,
    minIdleMs: 8000,
    targetTimeoutMs: 12000,
    lookChance: 0.25
  }, S.cfg || {})

  let pf = null
  function ensurePathfinder () {
    try { if (!pf) pf = require('mineflayer-pathfinder'); if (!bot.pathfinder) bot.loadPlugin(pf.pathfinder); return true } catch { return false }
  }

  let timer = null
  let lastMovedAt = Date.now()
  let lastPos = null
  let target = null
  let targetStartedAt = 0

  function isIdle () {
    try {
      if (!cfg.enabled) return false
      if (!bot.entity || !bot.entity.position) return false
      if (bot.vehicle) return false
      if (bot.isSleeping) return false
      if (bot.currentWindow) return false
      if (bot.pathfinder && bot.pathfinder.goal) return false
      const idleFor = Date.now() - lastMovedAt
      return idleFor >= cfg.minIdleMs
    } catch { return false }
  }

  function isAir (pos) { try { const b = bot.blockAt(pos); return !b || b.name === 'air' } catch { return false } }

  function findNearbyStandable (base, r) {
    // Find a point within radius r that has feet/head air and solid underfoot nearby
    r = Math.max(2, Math.min(12, r || cfg.radius))
    const tries = 16
    for (let i = 0; i < tries; i++) {
      const dx = Math.floor((Math.random() * 2 - 1) * r)
      const dz = Math.floor((Math.random() * 2 - 1) * r)
      const p = base.offset(dx, 0, dz)
      // scan small vertical band to land
      for (let dy = 2; dy >= -2; dy--) {
        const feet = p.offset(0, dy, 0)
        const head = feet.offset(0, 1, 0)
        const under = feet.offset(0, -1, 0)
        if (!isAir(feet) || !isAir(head)) continue
        const b = bot.blockAt(under)
        if (!b) continue
        const nm = String(b.name || '').toLowerCase()
        if (nm.includes('lava')) continue
        return feet
      }
    }
    return null
  }

  function maybeRandomLook () {
    if (Math.random() >= cfg.lookChance) return
    try {
      const yaw = Math.random() * Math.PI * 2
      const pitch = (Math.random() - 0.5) * 0.8
      bot.look(yaw, pitch, true)
    } catch {}
  }

  function tick () {
    try {
      const pos = bot.entity?.position
      if (pos) {
        if (!lastPos) { lastPos = pos.clone() }
        const moved = (() => { try { return pos.distanceTo(lastPos) } catch { return 0 } })()
        if (moved > 0.06) { // ignore tiny jitter
          lastPos = pos.clone()
          lastMovedAt = Date.now()
        }
      }
    } catch {}

    maybeRandomLook()

    if (!isIdle()) return
    if (!ensurePathfinder()) return
    const base = bot.entity?.position?.floored?.() || bot.entity?.position
    if (!base) return
    const dest = findNearbyStandable(base, cfg.radius)
    if (!dest) return
    const { Movements, goals } = pf
    const m = new Movements(bot, bot.mcData || require('minecraft-data')(bot.version))
    // Do not break blocks while casually wandering
    m.canDig = false
    m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, 1), true)
    target = dest
    targetStartedAt = Date.now()
    dlog && dlog('walk: goto', dest)
  }

  function heartbeat () {
    if (!target) return
    try {
      const now = Date.now()
      const me = bot.entity?.position
      if (!me) { target = null; return }
      const d = me.distanceTo(target)
      if (d <= 1.1 || (now - targetStartedAt) > cfg.targetTimeoutMs) {
        try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
        target = null
      }
    } catch { target = null }
  }

  function start () {
    if (timer) return
    timer = setInterval(() => { tick(); heartbeat() }, Math.max(800, cfg.intervalMs))
    dlog && dlog('walk: started')
  }
  function stop () { if (timer) { try { clearInterval(timer) } catch {} ; timer = null; dlog && dlog('walk: stopped') } }

  on('spawn', start)
  if (state?.hasSpawned) start()
  on('end', stop)
  on('agent:stop_all', () => { stop(); try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} ; target = null })

  // CLI: .walk on|off|status|radius N|minidle ms|interval ms|timeout ms|look PCT
  on('cli', ({ cmd, args }) => {
    if (String(cmd || '').toLowerCase() !== 'walk') return
    const sub = String(args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[WALK] enabled'); break
      case 'off': cfg.enabled = false; console.log('[WALK] disabled'); break
      case 'status': console.log('[WALK] enabled=', cfg.enabled, 'radius=', cfg.radius, 'intervalMs=', cfg.intervalMs, 'minIdleMs=', cfg.minIdleMs, 'timeoutMs=', cfg.targetTimeoutMs, 'lookChance=', cfg.lookChance); break
      case 'radius': cfg.radius = Math.max(2, parseInt(val || '6', 10)); console.log('[WALK] radius=', cfg.radius); break
      case 'interval': cfg.intervalMs = Math.max(800, parseInt(val || '4000', 10)); console.log('[WALK] intervalMs=', cfg.intervalMs); stop(); start(); break
      case 'minidle': cfg.minIdleMs = Math.max(1000, parseInt(val || '8000', 10)); console.log('[WALK] minIdleMs=', cfg.minIdleMs); break
      case 'timeout': cfg.targetTimeoutMs = Math.max(2000, parseInt(val || '12000', 10)); console.log('[WALK] targetTimeoutMs=', cfg.targetTimeoutMs); break
      case 'look': cfg.lookChance = Math.max(0, Math.min(1, parseFloat(val || '0.25'))); console.log('[WALK] lookChance=', cfg.lookChance); break
      default: console.log('[WALK] usage: .walk on|off|status|radius N|minidle ms|interval ms|timeout ms|look 0..1')
    }
  })

  registerCleanup && registerCleanup(() => { stop() })
}

module.exports = { install }
