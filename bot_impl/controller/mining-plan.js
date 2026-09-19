// Bounded local route planning over observed blocks; no language-model decisions.
const { Vec3 } = require('vec3')
const { fluid, fullSupport } = require('../navigation/liquids')
const { checkDig } = require('../safety')
const key = p => `${p.x},${p.y},${p.z}`
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
class Heap {
  constructor () { this.items = [] }
  push (v) { const a = this.items; a.push(v); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p].f <= v.f) break; a[i] = a[p]; i = p } a[i] = v }
  pop () { const a = this.items, first = a[0], last = a.pop(); if (a.length) { let i = 0; while (i * 2 + 1 < a.length) { let c = i * 2 + 1; if (c + 1 < a.length && a[c + 1].f < a[c].f) c++; if (a[c].f >= last.f) break; a[i] = a[c]; i = c } a[i] = last } return first }
}
function findRoute ({ start, goals, edge, limit = 6000 }) {
  const heuristic = p => Math.min(...goals.map(g => Math.abs(g.x - p.x) + Math.abs(g.z - p.z) + Math.max(0, p.y - g.y)))
  const goalKeys = new Set(goals.map(key)), heap = new Heap(), best = new Map()
  heap.push({ p: start, g: 0, f: heuristic(start), parent: null, cleared: [] })
  let explored = 0
  while (heap.items.length && explored++ < limit) {
    const node = heap.pop(), k = key(node.p)
    if (best.has(k) && best.get(k) < node.g) continue
    if (node.parent && goalKeys.has(k)) {
      const route = []; for (let n = node; n.parent; n = n.parent) route.push(n.p)
      return { route: route.reverse(), explored }
    }
    for (const [dx, dz] of directions) for (const dy of [0, -1]) {
      const p = { x: node.p.x + dx, y: node.p.y + dy, z: node.p.z + dz }
      if (p.y < -60 || Math.abs(p.x - start.x) + Math.abs(p.z - start.z) > 48) continue
      const g = node.g + 1 + (dy ? 0.1 : 0)
      if (best.has(key(p)) && best.get(key(p)) <= g) continue
      const result = edge(node, p)
      if (!result) continue
      best.set(key(p), g)
      heap.push({ p, g, f: g + heuristic(p), parent: node, cleared: result.cleared })
    }
  }
  return { route: null, explored }
}
function plan (bot, args = {}) {
  const start = bot.entity.position.floored()
  const types = ['diamond_ore', 'deepslate_diamond_ore'].map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  const ores = bot.findBlocks({ matching: types, maxDistance: args.radius || 32, count: 64 }).map(p => bot.blockAt(p, false)).filter(b => b && b.position.y <= start.y + 1 && checkDig(bot, b).ok)
  if (!ores.length) return { ok: false, error: 'no_safe_loaded_ore', position: start }
  const goals = ores.flatMap(b => [b.position, b.position.offset(0, -1, 0)]).filter(p => p.y <= start.y && p.y >= -60)
  const cache = new Map(), denied = {}
  const cell = p => {
    const k = key(p)
    if (!cache.has(k)) {
      const block = bot.blockAt(new Vec3(p.x, p.y, p.z), false)
      const dry = fluid(bot, block).kind === 'dry'
      const dig = block && block.boundingBox !== 'empty' ? checkDig(bot, block) : { ok: true }
      cache.set(k, { block, dry, dig })
    }
    return cache.get(k)
  }
  const result = findRoute({ start, goals, limit: args.maxNodes || 6000, edge: (node, p) => {
    const support = { x: p.x, y: p.y - 1, z: p.z }, floor = cell(support)
    if (!floor.dry || !fullSupport(floor.block)) return null
    const cleared = []
    for (let y = node.p.y + 1; y >= p.y; y--) {
      const pos = { x: p.x, y, z: p.z }, c = cell(pos)
      if (!c.dry) return null
      if (c.block.boundingBox === 'empty') continue
      if (!c.dig.ok) { denied[c.dig.error] = (denied[c.dig.error] || 0) + 1; return null }
      cleared.push(key(pos))
    }
    // Simulated earlier removals cannot become a future floor. Preserve every new stair.
    for (let n = node; n; n = n.parent) {
      if (n.cleared.includes(key(support))) return null
      if (cleared.includes(key({ x: n.p.x, y: n.p.y - 1, z: n.p.z }))) return null
    }
    return { cleared }
  } })
  if (!result.route) return { ok: false, error: 'no_safe_ore_route', explored: result.explored, candidates: ores.length, denied }
  const end = result.route.at(-1)
  const ore = ores.find(b => b.position.x === end.x && b.position.z === end.z && [end.y, end.y + 1].includes(b.position.y))
  return { ok: true, next: { action: 'tunnel_step', args: result.route[0] }, targetOre: ore?.position, steps: result.route.length, explored: result.explored, route: result.route }
}
module.exports = { plan, findRoute }
