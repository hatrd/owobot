const { Vec3 } = require('vec3')
const { Movements, goals } = require('./pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { body, cell } = require('./liquids')
async function observe (bot, args = {}) {
  const position = bot.entity?.position
  if (!position) return { ok: false, msg: 'Navigation unavailable', error: 'not_spawned' }
  if (args.range !== undefined && (!Number.isFinite(args.range) || args.range < 0.5 || args.range > 8)) return { ok: false, msg: 'Range must be 0.5 to 8', error: 'invalid_range' }
  const mode = args.liquidMode || 'wade'
  if (!['dry', 'wade'].includes(mode)) return { ok: false, msg: 'Unknown liquid mode', error: 'invalid_liquid_mode' }
  const data = { at: Date.now(), position: { x: position.x, y: position.y, z: position.z }, liquidMode: mode, body: body(bot), runtime: bot.state?.navigation || null, recovery: bot.state?.autoSwim?.runtime || null }
  if ([args.x, args.y, args.z].some(v => v !== undefined)) {
    if (![args.x, args.y, args.z].every(Number.isFinite)) return { ok: false, msg: 'Complete target coordinates required', error: 'invalid_position' }
    const target = new Vec3(args.x, args.y, args.z)
    if (target.distanceTo(position) > 128) return { ok: false, msg: 'Preview target must be within 128 blocks', error: 'preview_range' }
    const movements = new Movements(bot)
    movements.liquidMode = mode; movements.canDig = false; movements.allow1by1towers = false; movements.scafoldingBlocks = []; movements.allowSprinting = false
    const goal = new goals.GoalNear(target.x, target.y, target.z, args.range ?? 1.5)
    const start = new Move(position.x, position.y, position.z, 0, 0)
    const search = new AStar(start, movements, goal, 250, 30, 128)
    let result = search.compute()
    while (result.status === 'partial' && result.time < 200) {
      await new Promise(resolve => setImmediate(resolve))
      result = search.compute()
    }
    data.plan = { status: result.status, cost: result.cost, visitedNodes: result.visitedNodes, generatedNodes: result.generatedNodes, elapsedMs: result.time, target, nodes: result.path.length, path: result.path.slice(0, 64).map(p => ({ x: p.x, y: p.y, z: p.z, medium: cell(bot, p, mode).reason })), truncated: result.path.length > 64 }
  }
  return { ok: true, msg: data.plan ? `Navigation preview: ${data.plan.status}` : 'Navigation status', data }
}
module.exports = { observe }
