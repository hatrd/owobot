const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const register = require('../bot_impl/actions/modules/movement')
test('direct movement releases controls on completion and stop', async () => {
  const bot = new EventEmitter()
  bot.state = { cleanups: [] }
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.controlState = {}
  bot.look = async () => {}
  bot.setControlState = (key, value) => { bot.controlState[key] = value }
  bot.clearControlStates = () => { bot.controlState = {} }
  const tools = new Map(); const shared = {}
  register({ bot, shared, register: (name, fn) => tools.set(name, fn), registerCleanup () {}, ok: (msg, extra) => ({ ok: true, ...extra }), fail: (msg, extra) => ({ ok: false, ...extra }) })
  assert.equal((await tools.get('move_input')({ yaw: 0, forward: true, jump: true, durationMs: 50 })).ok, true)
  assert.deepEqual(bot.controlState, {})
  const result = tools.get('move_input')({ yaw: 0, forward: true, jump: true, durationMs: 5000 })
  await new Promise(resolve => setImmediate(resolve))
  bot.emit('agent:stop_all')
  assert.equal((await result).error, 'canceled')
  assert.deepEqual(bot.controlState, {})
  assert.equal(shared.inputPulse, null)
  assert.equal(bot.listenerCount('agent:stop_all'), 0)
  const reloaded = tools.get('move_input')({ yaw: 0, forward: true, jump: true, durationMs: 5000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await tools.get('move_input')({ yaw: 0, durationMs: 50 })).error, 'input_busy')
  bot.state.cleanups.splice(0).forEach(fn => fn())
  assert.equal((await reloaded).error, 'canceled')
  assert.deepEqual(bot.controlState, {})
  assert.equal(bot.state.cleanups.length, 0)
})
