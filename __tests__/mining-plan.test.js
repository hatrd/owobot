const test = require('node:test')
const assert = require('node:assert/strict')
const { findRoute } = require('../bot_impl/controller/mining-plan')
const start = { x: 0, y: 10, z: 0 }
test('local miner routes around a blocked direct corridor without outside waypoints', () => {
  const result = findRoute({ start, goals: [{ x: 3, y: 10, z: 0 }], edge: (n, p) => p.y === 10 && !(p.x === 1 && p.z === 0) ? { cleared: [] } : null })
  assert.ok(result.route)
  assert.ok(result.route.length > 3)
  assert.ok(result.route.every(p => p.x !== 1 || p.z !== 0))
  assert.deepEqual(result.route.at(-1), { x: 3, y: 10, z: 0 })
})
test('local miner finds a descending approach rather than a vertical drop', () => {
  const result = findRoute({ start, goals: [{ x: 1, y: 7, z: 0 }], edge: () => ({ cleared: [] }) })
  let previous = start
  for (const p of result.route) {
    assert.equal(Math.abs(p.x - previous.x) + Math.abs(p.z - previous.z), 1)
    assert.ok([0, -1].includes(p.y - previous.y)); previous = p
  }
  assert.equal(previous.y, 7)
})
test('bounded planning reports unreachable goals rather than an unsafe fallback', () => {
  const result = findRoute({ start, goals: [{ x: 1, y: 10, z: 0 }], edge: () => null, limit: 100 })
  assert.equal(result.route, null)
  assert.ok(result.explored <= 100)
})
const { Vec3 } = require('vec3')
const { plan } = require('../bot_impl/controller/mining-plan')
test('world planner avoids liquids and remembered return supports, not only geometric obstacles', () => {
  const ore = new Vec3(3, 10, 0)
  const bot = {
    entity: { position: new Vec3(0.5, 10, 0.5) }, game: { dimension: 'overworld' },
    registry: { blocksByName: { diamond_ore: { id: 4 }, deepslate_diamond_ore: { id: 5 }, water: { id: 9 }, lava: { id: 10 } } },
    state: { knowledge: { document: { records: [
      { id: 'mine', kind: 'mining', dimension: 'overworld', position: { x: 0, y: 10, z: 0 }, radius: 50, confidence: 'observed' },
      { id: 'old-stair', kind: 'route', dimension: 'overworld', position: { x: 2, y: 11, z: -1 }, radius: 0, confidence: 'observed' }
    ] } } },
    findBlocks: () => [ore],
    blockAt: p => {
      let name = 'stone', type = 1, empty = false
      if (p.x === 0 && p.z === 0 && [10, 11].includes(p.y)) { name = 'air'; type = 0; empty = true }
      if (p.x === 1 && p.y === 10 && p.z === 0) { name = 'water'; type = 9; empty = true }
      if (p.equals(ore)) { name = 'diamond_ore'; type = 4 }
      return { position: p, name, type, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
    }
  }
  const result = plan(bot)
  assert.equal(result.ok, true)
  assert.ok(result.route.length > 3)
  assert.ok(result.route.every(p => !(p.x === 1 && p.z === 0)))
  assert.ok(result.route.every(p => !(p.x === 2 && p.z === -1 && p.y <= 10 && p.y + 1 >= 10)))
})
