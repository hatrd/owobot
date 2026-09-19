const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const register = require('../bot_impl/actions/modules/combat')

test('explicit deposit and withdraw coordinates reach block lookup without constructor shadowing', async () => {
  const tools = new Map()
  const seen = []
  const bot = {
    mcData: {}, entity: { position: new Vec3(1, 64, 0) },
    pathfinder: { setMovements () {}, setGoal () {} },
    clearControlStates () {},
    blockAt (p) { seen.push(p); return null }
  }
  register({
    bot, Vec3, shared: {}, wait: async () => {},
    ensurePathfinder: () => true,
    pathfinder: { Movements: class {}, goals: { GoalNear: class {} } },
    register: (name, fn) => tools.set(name, fn),
    ok: msg => ({ ok: true, msg }), fail: msg => ({ ok: false, msg })
  })
  for (const name of ['deposit', 'withdraw']) {
    const result = await tools.get(name)({ x: 1, y: 64, z: 0, all: true })
    assert.equal(result.ok, false)
  }
  assert.equal(seen.length, 2)
  assert.ok(seen.every(p => p.equals(new Vec3(1, 64, 0))))
})
