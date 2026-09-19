const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { createStore } = require('../bot_impl/exploration/store')
const { survey } = require('../bot_impl/exploration/terrain')
const pose = (x = 0, dimension = 'overworld') => ({ dimension, position: { x, y: 64, z: 0 }, vitals: { health: 20, food: 18 }, at: 10 })
function fixture (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-memory-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const options = { state: {}, file: path.join(dir, 'memory.json'), worldId: 'world-a', now: () => 100000 }
  return { options, store: createStore(options) }
}
test('durable checkpoints survive a fresh process, isolate dimensions, and pause active missions', async t => {
  const { store, options } = fixture(t)
  const { mission } = await store.begin({ objective: 'explore', maxRadius: 32, pose: pose() })
  const saved = await store.checkpoint({ missionId: mission.id, pose: pose(4), landmarks: [{ key: 'cat', kind: 'entity', name: 'cat', text: 'cat', position: { x: 4, y: 64, z: 0 } }] })
  assert.equal(saved.ok, true)
  const fresh = createStore({ ...options, state: {} })
  const recalled = fresh.recall({ pose: pose() })
  assert.equal(recalled.missions[0].status, 'paused')
  assert.equal(recalled.missions[0].checkpoint.position.x, 4)
  assert.equal(recalled.landmarks.length, 1)
  assert.equal(fresh.recall({ pose: pose(0, 'nether') }).landmarks.length, 0)
  assert.equal((await fresh.checkpoint({ missionId: mission.id, pose: pose(0, 'nether') })).error, 'mission_dimension_mismatch')
})
test('serialized commits retain simultaneous observations and deduplicate task results', async t => {
  const { store } = fixture(t)
  const { mission } = await store.begin({ objective: 'explore', maxRadius: 32, pose: pose() })
  await Promise.all([2, 4, 6].map(x => store.checkpoint({ missionId: mission.id, pose: pose(x), attempt: { taskId: 'same', status: 'succeeded', target: { x, y: 64, z: 0 } } })))
  const result = store.recall({ pose: pose() })
  assert.equal(result.counts.visits, 3)
  assert.equal(result.counts.attempts, 1)
  assert.equal(result.revision, 4)
})
test('corrupt files fail visibly and are never overwritten as empty memory', async t => {
  const { options } = fixture(t)
  fs.writeFileSync(options.file, 'broken json')
  const store = createStore({ ...options, state: {} })
  assert.equal(store.recall({ pose: pose() }).ok, false)
  assert.equal((await store.begin({ objective: 'x', maxRadius: 8, pose: pose() })).error, 'memory_unavailable')
  assert.equal(fs.readFileSync(options.file, 'utf8'), 'broken json')
})
test('failed persistence does not publish a false successful mission', async t => {
  const { store, options } = fixture(t)
  fs.mkdirSync(options.file)
  const result = await store.begin({ objective: 'x', maxRadius: 8, pose: pose() })
  assert.equal(result.error, 'memory_save_failed')
  assert.equal(store.document().missions.length, 0)
})
test('entity locations age out without being presented as current evidence', async t => {
  const { store, options } = fixture(t)
  const { mission } = await store.begin({ objective: 'x', maxRadius: 8, pose: pose() })
  await store.checkpoint({ missionId: mission.id, pose: pose(), landmarks: [{ key: 'cat', kind: 'entity', position: pose().position }] })
  const later = createStore({ ...options, state: {}, now: () => 200001 })
  assert.equal(later.recall({ pose: pose() }).landmarks[0].stale, true)
})
test('terrain excludes unknown chunks, lava, water and walls, then ranks unvisited cells', () => {
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' }, registry: { blocksByName: { lava: { id: 3 }, water: { id: 4 } } }, state: {}, blockAt (p) {
    if (p.x >= 4) return null
    if (p.x === -2) return { name: 'wall', type: 2, boundingBox: 'block' }
    if (p.y < 64) return { name: 'stone', type: 1, boundingBox: 'block' }
    if (p.z === 2) return { name: 'lava', type: 3, boundingBox: 'empty' }
    return { name: 'air', type: 0, boundingBox: 'empty' }
  } }
  const data = survey(bot, { radius: 6, max: 40 }).data
  assert.ok(data.candidates.length > 0)
  assert.ok(data.candidates.every(c => c.position.x < 4 && c.position.x > -2 && c.position.z < 2))
  bot.state.explorationMemory = { document: { missions: [], attempts: [], visits: [{ dimension: 'overworld', position: data.candidates[0].position, count: 4 }] } }
  assert.equal(survey(bot, { radius: 6, max: 1 }).data.candidates[0].visits, 0)
})

test('structurally invalid documents fail explicitly before querying nested records', t => {
  const { options } = fixture(t)
  fs.writeFileSync(options.file, JSON.stringify({ version: 1, worldId: 'world-a', revision: 1, missions: [null], visits: [], landmarks: [], attempts: [] }))
  const store = createStore({ ...options, state: {} })
  assert.equal(store.recall({ pose: pose() }).error, 'invalid_exploration_document')
})
