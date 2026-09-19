// Bounded, read-only local search. No pathfinder goals, digging, or guessed air in unloaded chunks.
const { Vec3 } = require('vec3')
const { fluid, fullSupport, cell } = require('./liquids')
function planEscape (bot, { radius = 6, rise = 24, maxNodes = 1200 } = {}) {
  const start = bot.entity.position.floored()
  const cache = new Map()
  const at = p => { const key = p.toString(); if (!cache.has(key)) cache.set(key, bot.blockAt(p, false)); return cache.get(key) }
  const open = b => b && b.boundingBox === 'empty' && !['lava', 'unknown'].includes(fluid(bot, b).kind)
  function inspect (p) {
    const feet = at(p); const head = at(p.offset(0, 1, 0)); const floor = at(p.offset(0, -1, 0))
    if (!open(feet) || !open(head) || !floor || fluid(bot, floor).kind === 'lava') return null
    const wet = fluid(bot, feet).kind === 'water'
    if (!wet && !fullSupport(floor)) return null
    const breathable = fluid(bot, head).kind === 'dry'
    return { shore: !wet && breathable && cell(bot, p, 'dry').allowed, surface: wet && breathable }
  }
  const queue = [{ p: start, parent: -1 }]; const seen = new Set([start.toString()])
  let surface = -1; let found = -1; let processed = 0
  for (let i = 0; i < queue.length && i < maxNodes; i++) {
    processed++
    const p = queue[i].p; const info = inspect(p)
    if (info?.shore) { found = i; break }
    if (info?.surface && surface < 0) surface = i
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
      const q = p.offset(dx, dy, dz)
      if (Math.abs(q.x - start.x) > radius || Math.abs(q.z - start.z) > radius || q.y - start.y > rise) continue
      if (seen.has(q.toString()) || !inspect(q)) continue
      if (dy && !open(at(p.offset(0, 2, 0)))) continue
      seen.add(q.toString()); queue.push({ p: q, parent: i })
    }
  }
  if (found < 0) found = surface
  if (found < 0) return { ok: false, error: 'no_local_escape', visited: processed, truncated: processed >= maxNodes }
  const destination = queue[found].p
  const kind = inspect(destination).shore ? 'shore' : 'surface'
  const route = []
  for (let i = found; i >= 0; i = queue[i].parent) route.unshift({ x: queue[i].p.x + 0.5, y: queue[i].p.y, z: queue[i].p.z + 0.5 })
  return { ok: true, kind, route, visited: processed, truncated: processed >= maxNodes }
}
module.exports = { planEscape }
