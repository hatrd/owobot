const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const registry = require('minecraft-data')('1.21.4')
const { planEscape } = require('../bot_impl/navigation/recovery')
const { install } = require('../bot_impl/auto-swim')
function fixture (map) {
  const bot = new EventEmitter()
  bot.registry = registry; bot.entity = { position: new Vec3(0.5, 48, 0.5), onGround: false }
  bot.state = { hasSpawned: true }; bot.controlState = {}; bot.look = async () => {}
  bot.setControlState = (key, value) => { bot.controlState[key] = value }
  bot.blockAt = p => {
    p = p.floored(); const name = map(p)
    if (!name) return null
    const solid = name === 'stone'
    return { name, type: registry.blocksByName[name].id, position: p, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) }
  }
  return bot
}
test('deep open water finds an ascent and never treats unloaded ceiling as breathable', () => {
  const bot = fixture(p => Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2 ? p.y < 48 ? 'stone' : p.y <= 62 ? 'water' : 'air' : null)
  const result = planEscape(bot)
  assert.equal(result.ok, true); assert.equal(result.kind, 'surface')
  assert.equal(result.route.at(-1).y, 62)
  bot.blockAt = () => null
  assert.equal(planEscape(bot).error, 'no_local_escape')
})
test('bounded search routes around a low roof to a supported shore', () => {
  const bot = fixture(p => {
    if (Math.abs(p.x) > 3 || Math.abs(p.z) > 2 || p.y > 53) return null
    if (p.y < 48 || (p.x === 0 && p.y === 50) || (p.x === 2 && p.y === 49)) return 'stone'
    return p.y <= 49 && p.x !== 2 ? 'water' : 'air'
  })
  const result = planEscape(bot)
  assert.equal(result.ok, true); assert.equal(result.kind, 'shore')
  assert.ok(result.route.some(p => Math.abs(p.x - 0.5) >= 1))
  assert.ok(result.route.every(p => !(Math.floor(p.x) === 0 && Math.floor(p.y) === 50)))
})
test('recovery has one busy contribution, no pathfinder goals, bounded stall and reload cleanup', () => {
  const bot = fixture(p => Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2 ? p.y < 48 ? 'stone' : p.y <= 62 ? 'water' : 'air' : null)
  let time = 0; const cleanup = []
  bot.pathfinder = { goal: null, setGoal: () => { throw new Error('must not create goals') } }
  const api = install(bot, { state: bot.state, on: bot.on.bind(bot), registerCleanup: fn => cleanup.push(fn), now: () => time })
  try {
    api.tick(); assert.equal(bot.controlState.jump, true); assert.equal(bot.state.externalBusyCount, 1)
    bot.controlState.jump = false; api.tick(); assert.equal(bot.controlState.jump, true); assert.equal(bot.state.externalBusyCount, 1)
    time = 8100; api.tick(); assert.equal(bot.state.autoSwim.runtime.phase, 'blocked'); assert.equal(bot.controlState.forward, false)
    cleanup.forEach(fn => fn()); assert.equal(bot.state.externalBusyCount, 0); assert.equal(bot.controlState.jump, false)
  } finally { api.stop() }
})
test('recovery yields to explicit input and releases on reaching supported dry ground', () => {
  const bot = fixture(p => p.y < 48 ? 'stone' : p.y <= 62 ? 'water' : 'air')
  const cleanup = []; const api = install(bot, { state: bot.state, on: bot.on.bind(bot), registerCleanup: fn => cleanup.push(fn) })
  try {
    api.tick(); bot.state.externalBusyCount++; api.tick()
    assert.equal(bot.state.autoSwim.runtime.active, false); assert.equal(bot.state.externalBusyCount, 1)
    bot.state.externalBusyCount = 0; bot.state.externalBusy = false
    api.tick(); bot.entity.position = new Vec3(0.5, 63, 0.5); bot.entity.onGround = true
    const prior = bot.blockAt; bot.blockAt = p => p.floored().y === 62 ? { ...prior(p), type: registry.blocksByName.stone.id, boundingBox: 'block', shapes: [[0,0,0,1,1,1]] } : prior(p)
    api.tick(); assert.equal(bot.state.externalBusyCount, 0); assert.equal(bot.state.autoSwim.runtime.active, false)
  } finally { api.stop() }
})
