// High-level go skill: navigate to coords or follow a player until within radius

function ensurePathfinder (bot, log) {
  try {
    const pkg = require('mineflayer-pathfinder')
    if (!bot.pathfinder) bot.loadPlugin(pkg.pathfinder)
    const { Movements } = pkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    return { ok: true, pkg, m }
  } catch (e) { log && log.warn && log.warn('pathfinder missing'); return { ok: false } }
}

module.exports = function goFactory ({ bot, args, log }) {
  const radius = Math.max(1, parseFloat(args.radius || '1.5'))
  let target = null
  let followEnt = null
  let lastD = null
  let lastDAt = 0
  let inited = false

  function resolveTarget () {
    if (args.to && typeof args.to === 'object' && Number.isFinite(args.to.x)) { target = { x: Math.round(args.to.x), y: Math.round(args.to.y), z: Math.round(args.to.z) }; return }
    if (args.player) { const rec = bot.players?.[args.player]; followEnt = rec?.entity || null; return }
    if (Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z)) { target = { x: Math.round(args.x), y: Math.round(args.y), z: Math.round(args.z) }; return }
  }

  function start () {
    const pf = ensurePathfinder(bot, log)
    if (!pf.ok) throw new Error('无寻路')
    resolveTarget()
    const { goals } = pf.pkg
    if (followEnt) {
      bot.pathfinder.setMovements(pf.m)
      bot.pathfinder.setGoal(new goals.GoalFollow(followEnt, radius), true)
    } else if (target) {
      bot.pathfinder.setMovements(pf.m)
      bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, radius))
    } else {
      throw new Error('缺少目标')
    }
    inited = true
  }

  function currentDistance () {
    try {
      const me = bot.entity?.position
      const t = followEnt ? followEnt?.position : (target ? new (require('vec3').Vec3)(target.x, target.y, target.z) : null)
      if (!me || !t) return Infinity
      return me.distanceTo(t)
    } catch { return Infinity }
  }

  async function tick () {
    if (!inited) start()
    const d = currentDistance()
    const now = Date.now()
    if (d <= radius + 0.2) return { status: 'succeeded', progress: 1, events: [{ type: 'arrived', d }] }
    if (lastD == null || d + 0.1 < lastD) { lastD = d; lastDAt = now }
    // if no improvement for 8s, nudge by resetting goal
    if (now - lastDAt > 8000) {
      try {
        const pf = ensurePathfinder(bot, log)
        if (pf.ok) {
          const { goals } = pf.pkg
          if (followEnt) bot.pathfinder.setGoal(new goals.GoalFollow(followEnt, radius), true)
          else if (target) bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, radius))
        }
      } catch {}
      lastDAt = now
      return { status: 'running', progress: Math.max(0, Math.min(0.9, 1 / (1 + d))), events: [{ type: 'path_retry', d }] }
    }
    return { status: 'running', progress: Math.max(0, Math.min(0.9, 1 / (1 + d))) }
  }

  function cancel () { try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {} }

  return { start, tick, cancel }
}

