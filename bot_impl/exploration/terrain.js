const { Vec3 } = require('vec3')
const positionKey = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Explicit Minecraft block mechanics, not interpretation of text or task descriptions.
const HAZARDS = ['lava', 'water', 'fire', 'soul_fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow', 'sweet_berry_bush', 'wither_rose', 'nether_portal', 'end_portal']
function survey (bot, args = {}) {
  const me = bot.entity?.position
  if (!me) return { ok: false, msg: 'Terrain unavailable', error: 'not_spawned' }
  const radius = Math.max(3, Math.min(12, Math.floor(Number(args.radius) || 8)))
  const max = Math.max(1, Math.min(40, Math.floor(Number(args.max) || 12)))
  const origin = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }
  const hazardous = new Set(HAZARDS.map(name => bot.registry?.blocksByName?.[name]?.id).filter(Number.isFinite))
  const cache = new Map()
  const block = p => {
    const key = positionKey(p)
    if (!cache.has(key)) cache.set(key, bot.blockAt(new Vec3(p.x, p.y, p.z), false))
    return cache.get(key)
  }
  const clear = b => b && b.boundingBox === 'empty' && !hazardous.has(b.type)
  const standable = p => {
    const floor = block({ ...p, y: p.y - 1 })
    return floor && floor.boundingBox === 'block' && !hazardous.has(floor.type) && clear(block(p)) && clear(block({ ...p, y: p.y + 1 }))
  }
  const queue = [{ ...origin, steps: 0 }]
  const seen = new Set([positionKey(origin)])
  const candidates = []
  for (let index = 0; index < queue.length && index < 1600; index++) {
    const p = queue[index]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1]) {
        const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz, steps: p.steps + 1 }
        if (Math.abs(q.x - origin.x) > radius || Math.abs(q.z - origin.z) > radius || Math.abs(q.y - origin.y) > 4) continue
        if (!standable(q)) continue
        if (dy === 1 && !clear(block({ ...p, y: p.y + 2 }))) continue
        if (dy === -1 && !clear(block({ ...q, y: q.y + 2 }))) continue
        const key = positionKey(q)
        if (!seen.has(key)) {
          seen.add(key); queue.push(q)
          const position = { x: q.x + 0.5, y: q.y, z: q.z + 0.5 }
          const d = distance(position, me)
          if (d >= 3 && d <= radius) candidates.push({ position, distance: Math.round(d * 100) / 100, steps: q.steps, support: block({ ...q, y: q.y - 1 }).name })
        }
        break
      }
    }
  }
  const dimension = String(bot.game?.dimension || 'unknown')
  const memory = bot.state?.explorationMemory?.document
  const mission = memory?.missions.find(m => m.status === 'active')
  for (const candidate of candidates) {
    const visits = memory?.visits.filter(v => v.dimension === dimension && distance(v.position, candidate.position) < 3) || []
    candidate.visits = visits.reduce((n, v) => n + v.count, 0)
    candidate.recentFailure = Boolean(memory?.attempts.some(a => a.dimension === dimension && a.target && distance(a.target, candidate.position) < 2 && a.status !== 'succeeded' && Date.now() - a.at < 3600000))
    candidate.withinMission = !mission || (mission.dimension === dimension && distance(mission.home, candidate.position) <= mission.maxRadius)
  }
  candidates.sort((a, b) => Number(a.recentFailure) - Number(b.recentFailure) || Number(b.withinMission) - Number(a.withinMission) || a.visits - b.visits || b.distance - a.distance)
  return { ok: true, msg: `Terrain: ${candidates.length} reachable candidate cells`, data: {
    at: Date.now(), dimension, origin: { x: me.x, y: me.y, z: me.z }, radius,
    reachableCells: seen.size, truncated: queue.length >= 1600, candidates: candidates.slice(0, max),
    limitation: 'Local conservative block connectivity, not a pathfinder guarantee; recheck before movement.'
  } }
}
module.exports = { survey, distance, positionKey }
