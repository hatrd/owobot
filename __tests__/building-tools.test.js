const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const actions = require('../bot_impl/actions')
const register = require('../bot_impl/actions/modules/building')
const carried = require('../bot_impl/agent/carried-containers')
function harness () {
  const target = new Vec3(1, 64, 0)
  const signItem = { type: 1, name: 'cherry_sign', count: 1 }
  let placed = false
  let written = []
  const bot = { state: {}, entity: { position: new Vec3(0, 64, 0) }, _client: new EventEmitter(), inventory: { items: () => [signItem] }, blockAt (p) {
    return { position: p, name: p.y < 64 ? 'stone' : placed && p.equals(target) ? 'cherry_sign' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }
  }, equip: async () => {}, placeBlock: async () => { placed = true; bot._client.emit('open_sign_entity', { location: target }) }, updateSign: (_block, text) => { written = text.split('\n') } }
  const registry = new Map()
  register({ bot, shared: {}, Vec3, assertCanEquipHand: () => {}, wait: () => Promise.resolve(), register: (name, fn) => registry.set(name, fn), ok: (msg, extra) => ({ ok: true, msg, ...extra }), fail: (msg, extra) => ({ ok: false, msg, ...extra }), observer: { detail: async () => ({ data: placed ? [{ x: 1, y: 64, z: 0, front: written }] : [] }) } })
  return { bot, registry, placed: () => placed }
}
test('place_sign confirms server-readable text and refuses to overwrite existing blocks', async () => {
  const h = harness()
  const args = { item: 'cherry_sign', position: { x: 1, y: 64, z: 0 }, lines: ['hello', 'world'] }
  const result = await h.registry.get('place_sign')(args)
  assert.equal(result.ok, true)
  assert.equal(result.data.stage, 'confirmed')
  assert.deepEqual(result.data.observed.front, args.lines)
  assert.equal(h.bot._client.listenerCount('open_sign_entity'), 0)
  assert.equal((await h.registry.get('place_sign')(args)).error, 'occupied_target')
})
test('missing sign inventory returns diagnostics without placing anything', async () => {
  const h = harness(); h.bot.inventory.items = () => []
  assert.equal((await h.registry.get('place_sign')({ item: 'cherry_sign', position: { x: 1, y: 64, z: 0 }, lines: ['hi'] })).error, 'missing_sign_item')
  assert.equal(h.placed(), false)
})
test('dry place validates lines and never equips or places', async () => {
  const bot = { state: {}, equip: () => { throw new Error('must not execute') } }
  const a = actions.install(bot)
  const args = { item: 'oak_sign', position: { x: 0, y: 64, z: 0 }, lines: ['hello'] }
  assert.equal((await a.dry('place_sign', args)).ok, true)
  assert.equal((await a.dry('place_sign', { ...args, lines: ['wrong\nline'] })).ok, false)
  assert.equal((await a.dry('place_sign', { ...args, position: { x: 0.5, y: 64, z: 0 } })).ok, false)
})
test('carried container observation uses item components without interacting with the world', () => {
  const bot = { registry: { items: { 7: { name: 'oak_sign' } } }, inventory: { items: () => [
    { name: 'pink_shulker_box', slot: 12, components: [{ type: 'container', data: { contents: [{ itemId: 7, itemCount: 3 }] } }] },
    { name: 'shulker_box', slot: 13 }
  ] } }
  const r = carried.read(bot)
  assert.deepEqual(r[0].items, [{ slot: 0, name: 'oak_sign', count: 3 }])
  assert.equal(r[1].source, 'unavailable')
})
test('craft preview reports shortages and crafting refuses unavailable ingredients', async () => {
  const h = harness()
  h.bot.registry = { itemsByName: { cherry_sign: { id: 1 } }, items: { 2: { name: 'cherry_planks' } } }
  h.bot.recipesAll = () => [{ result: { count: 3 }, requiresTable: true, delta: [{ id: 2, count: -6 }] }]
  h.bot.craft = () => { throw new Error('must not craft') }
  const plan = h.registry.get('craft_preview')({ item: 'cherry_sign', count: 1 })
  assert.equal(plan.data.recipes[0].ingredients[0].needed, 6)
  assert.equal((await h.registry.get('craft_item')({ item: 'cherry_sign' })).error, 'missing_ingredients')
})

test('sign observation retains repeated lines for exact readback', async () => {
  const observer = require('../bot_impl/agent/observer')
  const p = new Vec3(1, 64, 0)
  const bot = { entity: { position: new Vec3(0, 64, 0) }, findBlocks: () => [p], blockAt: () => ({ name: 'oak_sign', position: p, getSignText: () => ['same\nsame\nlast', ''] }) }
  const result = await observer.detail(bot, { what: 'signs', radius: 6, max: 5 })
  assert.deepEqual(result.data[0].front, ['same', 'same', 'last'])
})

test('block_at reads exact coordinates and diagnoses unloaded blocks', async () => {
  const observer = require('../bot_impl/agent/observer')
  const bot = { blockAt: p => p.x === 1 ? { name: 'air', position: p, boundingBox: 'empty' } : null }
  assert.equal(observer.detail(bot, { what: 'block_at', x: 1, y: 64, z: 0 }).data.name, 'air')
  assert.equal(observer.detail(bot, { what: 'block_at', x: 2, y: 64, z: 0 }).error, 'unloaded_block')
})
