const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { createNavigator } = require('../bot_impl/navigation/drive')
function fixture (t) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const bot = new EventEmitter(); const state = {}
  bot.registry = require('minecraft-data')('1.21.4'); bot.entity = { position: new Vec3(0, 64, 0) }
  bot.clearControlStates = () => {}
  bot.pathfinder = { goal: null, setGoal (g) { this.goal = g }, setMovements () {} }
  let time = 0
  const api = createNavigator(bot, state, { now: () => time })
  return { bot, state, api, tick: value => { time = value; t.mock.timers.tick(100) }, start: () => api.start({ x: 8, y: 64, z: 0 }, { canceled: false }) }
}
test('noPath is a prompt structured failure and releases every listener/goal', async t => {
  const h = fixture(t); const result = h.start()
  h.bot.emit('path_update', { status: 'noPath', path: [], visitedNodes: 40 })
  const r = await result
  assert.equal(r.error, 'navigation_no_path'); assert.equal(r.data.path.visitedNodes, 40)
  assert.equal(h.bot.pathfinder.goal, null); assert.equal(h.bot.listenerCount('path_update'), 0)
})
test('stationary navigation replans only once then fails without waiting for outer timeout', async t => {
  const h = fixture(t); const result = h.start()
  h.tick(8100); assert.equal(h.state.navigation.replans, 1)
  h.tick(16200); assert.equal((await result).error, 'navigation_stalled')
  assert.equal(h.bot.pathfinder.goal, null)
})
test('cancel settles pending navigation and ignores late path events', async t => {
  const h = fixture(t); const result = h.start(); h.api.stop('reload')
  assert.equal((await result).error, 'reload')
  h.bot.emit('path_update', { status: 'success', path: [{ x: 8, y: 64, z: 0 }] })
  assert.equal(h.state.navigation.reason, 'reload')
  assert.equal(h.bot.listenerCount('path_reset'), 0)
})
