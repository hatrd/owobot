const test = require('node:test')
const assert = require('node:assert/strict')
const { discard } = require('../bot_impl/controller/excavate')
function fixture () {
  const cancel = { canceled: false }, looks = [], thrown = []
  let count = 64
  const bot = {
    entity: { yaw: 0.7, pitch: -0.2 },
    inventory: { items: () => count ? [{ name: 'stone', count, type: 1, metadata: 0 }] : [] },
    look: async (yaw, pitch) => { looks.push({ yaw, pitch }) },
    toss: async (type, metadata, amount) => { thrown.push(amount); count -= amount }
  }
  return { bot, cancel, looks, thrown }
}
test('discard preserves a reserve and restores heading after throwing backwards', async () => {
  const f = fixture()
  const result = await discard(f.bot, { item: 'stone', keep: 32 }, f.cancel)
  assert.equal(result.ok, true)
  assert.equal(result.data.after, 32)
  assert.deepEqual(f.thrown, [32])
  assert.deepEqual(f.looks, [{ yaw: 0.7 + Math.PI, pitch: 0 }, { yaw: 0.7, pitch: -0.2 }])
})
test('cancellation during orientation prevents discard and further view writes', async () => {
  const f = fixture()
  f.bot.look = async () => { f.cancel.canceled = true }
  const result = await discard(f.bot, { item: 'stone', keep: 0 }, f.cancel)
  assert.equal(result.error, 'canceled')
  assert.deepEqual(f.thrown, [])
})
test('failed inventory write restores the original view and propagates failure', async () => {
  const f = fixture()
  f.bot.toss = async () => { throw new Error('server rejected') }
  await assert.rejects(discard(f.bot, { item: 'stone', keep: 0 }, f.cancel), /server rejected/)
  assert.deepEqual(f.looks.at(-1), { yaw: 0.7, pitch: -0.2 })
})
