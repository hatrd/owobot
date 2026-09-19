const { randomUUID } = require('crypto')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('./pathfinder')
function reached (bot, target, p) {
  if (target.isEnd(p.floored())) return true
  const block = bot.blockAt?.(p.floored(), false)
  const top = Math.max(0, ...(block?.shapes || []).map(shape => shape[4]))
  return top > 0 && top < 1 && Math.abs(p.y - Math.floor(p.y) - top) < 0.08 && target.isEnd(p.floored().offset(0, 1, 0))
}
function createNavigator (bot, state, { now = Date.now } = {}) {
  let operation = null
  function stop (reason = 'canceled') { operation?.finish(false, reason) }
  function start (args, cancellation, boundary = () => true) {
    stop('replaced')
    if (cancellation.canceled) return Promise.resolve({ ok: false, error: 'canceled' })
    if (!bot.pathfinder) bot.loadPlugin(pathfinder)
    const movements = new Movements(bot)
    movements.canDig = false; movements.allowSprinting = false; movements.allow1by1towers = false; movements.scafoldingBlocks = []
    const target = new goals.GoalNear(args.x, args.y, args.z, args.range ?? 1.5)
    const p = bot.entity.position
    const s = state.navigation = { id: randomUUID(), phase: 'planning', target: { ...args }, liquidMode: movements.liquidMode, startedAt: now(), lastProgressAt: now(), lastPosition: { x: p.x, y: p.y, z: p.z }, replans: 0, pathResets: 0, lastReset: null, path: null, reason: null }
    return new Promise(resolve => {
      let timer = null
      const current = { finish }
      operation = current
      function finish (ok, reason) {
        if (operation !== current) return
        operation = null
        clearInterval(timer)
        bot.off('path_update', onPath); bot.off('path_reset', onReset)
        if (bot.pathfinder.goal === target) { bot.pathfinder.setGoal(null); bot.clearControlStates?.() }
        s.phase = ok ? 'arrived' : 'failed'; s.reason = reason; s.finishedAt = now()
        resolve({ ok, ...(ok ? {} : { error: reason }), data: JSON.parse(JSON.stringify(s)) })
      }
      function onPath (result) {
        if (bot.pathfinder.goal !== target) return
        s.path = { status: result.status, nodes: result.path?.length || 0, cost: result.cost ?? null, visitedNodes: result.visitedNodes ?? null, at: now() }
        // Upstream assigns its result path AFTER emitting path_update. Stop on the
        // microtask boundary so a failed search cannot reinstall a partial path.
        if (result.status === 'noPath' || result.status === 'timeout') {
          queueMicrotask(() => finish(false, result.status === 'noPath' ? 'navigation_no_path' : 'navigation_search_timeout'))
          return
        }
        s.phase = result.path?.length ? 'moving' : 'planning'
      }
      function onReset (reason) { if (bot.pathfinder.goal === target) { s.pathResets++; s.lastReset = reason } }
      bot.on('path_update', onPath); bot.on('path_reset', onReset)
      try {
        bot.pathfinder.setMovements(movements)
        bot.pathfinder.setGoal(target)
        if (operation !== current) return
        timer = setInterval(() => {
          if (operation !== current) return
          if (cancellation.canceled) return finish(false, 'canceled')
          const p = bot.entity?.position
          if (!p) return finish(false, 'not_spawned')
          if (!boundary(p)) return finish(false, 'mission_radius_exceeded')
          if (reached(bot, target, p)) return finish(true, 'arrived')
          if (bot.pathfinder.goal !== target) return finish(false, 'navigation_interrupted')
          if (p.distanceTo(new Vec3(s.lastPosition.x, s.lastPosition.y, s.lastPosition.z)) >= 0.4) {
            s.lastProgressAt = now(); s.lastPosition = { x: p.x, y: p.y, z: p.z }
          }
          if (now() - s.lastProgressAt >= 8000) {
            if (s.replans >= 1) return finish(false, 'navigation_stalled')
            s.replans++; s.lastProgressAt = now(); s.phase = 'replanning'
            bot.pathfinder.setGoal(target)
          }
        }, 100)
        timer.unref?.()
      } catch (error) { finish(false, String(error.message || error)) }
    })
  }
  return { start, stop }
}
module.exports = { createNavigator, reached }
