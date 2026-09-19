const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { install } = require('../bot_impl/auto-swim')

test('swimming reasserts jump after another module clears controls', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const cleanup = []
  const bot = {
    controlState: { jump: false }, entity: { position: new Vec3(0, 48, 0), velocity: { y: 0 } },
    blockAt: () => ({ name: 'water' }),
    setControlState (name, value) { this.controlState[name] = value },
    lookAt: async () => {}
  }
  install(bot, {
    state: { hasSpawned: true, autoSwim: { cfg: { forceSurfaceMs: 100000 } } },
    on () {}, registerCleanup: fn => cleanup.push(fn)
  })
  t.mock.timers.tick(120)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bot.controlState.jump, true)
  bot.controlState.jump = false
  t.mock.timers.tick(120)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bot.controlState.jump, true)
  cleanup.forEach(fn => fn())
  assert.equal(bot.controlState.jump, false)
})
