const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')('1.21.4')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { Movements, goals } = require('../bot_impl/navigation/pathfinder')
const { fluid, cell } = require('../bot_impl/navigation/liquids')
function block (name, p, props = {}) {
  const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
  b.position = p.clone(); b.getProperties = () => props; b.isWaterlogged = props.waterlogged === true
  return b
}
function world (overrides = new Map()) {
  const bot = { registry, game: { minY: -64 }, entity: { position: new Vec3(0, 64, 0), effects: {} }, inventory: { items: () => [] }, entities: {} }
  bot.blockAt = p => {
    p = p.floored()
    if (Math.abs(p.x) > 12 || Math.abs(p.z) > 12 || p.y > 68 || p.y < 59) return null
    const entry = overrides.get(p.toString())
    if (entry === null) return null
    return block(entry?.name || (p.y <= 63 ? 'stone' : 'air'), p, entry?.props)
  }
  return bot
}
function route (bot, target) {
  const m = new Movements(bot); m.canDig = false; m.allow1by1towers = false; m.scafoldingBlocks = []
  const astar = new AStar(new Move(0, 64, 0, 0, 0), m, new goals.GoalBlock(...target), 2000, 2000, 30)
  return astar.compute()
}
test('registry water plants, bubble columns and waterlogged coral are classified as water', () => {
  const bot = world(); const p = new Vec3(0, 64, 0)
  for (const name of ['water', 'kelp', 'seagrass', 'bubble_column']) assert.equal(fluid(bot, block(name, p)).kind, 'water')
  const coral = block('horn_coral_wall_fan', p, { waterlogged: true })
  assert.equal(fluid(bot, coral).kind, 'water')
  assert.equal(fluid(bot, block('horn_coral_wall_fan', p, { waterlogged: false })).kind, 'dry')
  assert.equal(fluid(bot, null).kind, 'unknown')
})
test('actual upstream A* takes a dry detour around a deep waterlogged trench', () => {
  const overrides = new Map()
  for (let z = -1; z <= 1; z++) for (let y = 60; y <= 64; y++) overrides.set(new Vec3(2, y, z).toString(), { name: y === 64 ? 'horn_coral_wall_fan' : 'water', props: { waterlogged: true } })
  const bot = world(overrides); const result = route(bot, [6, 64, 0])
  assert.equal(result.status, 'success')
  assert.ok(result.path.some(p => Math.abs(p.z) >= 2))
  assert.ok(result.path.every(p => cell(bot, p).allowed))
  assert.equal(new Movements(bot).getBlock(new Vec3(2, 64, 0), 0, 0, 0).liquid, true)
})
test('shallow source water is supported but currents, lava, deep water and unknown headroom are rejected', () => {
  const p = new Vec3(1, 64, 0); const overrides = new Map([[p.toString(), { name: 'water' }]])
  const bot = world(overrides)
  assert.equal(cell(bot, p).reason, 'wading')
  assert.equal(cell(bot, p, 'dry').allowed, false)
  overrides.set(p.toString(), { name: 'water', props: { level: 1 } })
  assert.equal(cell(bot, p).reason, 'water_current')
  overrides.set(p.toString(), { name: 'lava' }); assert.equal(cell(bot, p).reason, 'lava')
  overrides.set(p.toString(), { name: 'water' }); overrides.set(p.offset(0, -1, 0).toString(), { name: 'water' })
  assert.equal(cell(bot, p).reason, 'deep_water')
  overrides.set(p.offset(0, 1, 0).toString(), null); assert.equal(cell(bot, p).reason, 'unloaded')
})
test('an island with no shallow exit returns noPath instead of planning a dive', () => {
  const overrides = new Map()
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) {
    if (x === 0 && z === 0) continue
    for (let y = 60; y <= 64; y++) overrides.set(new Vec3(x, y, z).toString(), { name: 'water' })
  }
  assert.equal(route(world(overrides), [6, 64, 0]).status, 'noPath')
})
