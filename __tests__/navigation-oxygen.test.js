const test = require('node:test')
const assert = require('node:assert/strict')
const { oxygen } = require('../bot_impl/navigation/oxygen')
test('nearby entity oxygen cannot overwrite the current player oxygen fact', () => {
  const bot = { registry: require('minecraft-data')('1.21.4'), entity: { metadata: { 1: 300 } }, oxygenLevel: 7 }
  assert.deepEqual(oxygen(bot), { level: 20, airTicks: 300, source: 'self_entity_metadata' })
  bot.oxygenLevel = 274; bot.entity.metadata[1] = 60
  assert.equal(oxygen(bot).level, 4)
  delete bot.entity.metadata[1]
  assert.equal(oxygen(bot).level, null)
})
test('metadata mapping comes from the registry rather than a fixed slot number', () => {
  const bot = { registry: { entitiesByName: { player: { metadataKeys: ['other', 'another', 'air_supply'] } } }, entity: { metadata: { 1: 0, 2: 300 } } }
  assert.equal(oxygen(bot).level, 20)
  assert.equal(oxygen({ oxygenLevel: 18 }).level, 18)
})
