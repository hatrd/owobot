const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { decide } = require('../bot_impl/life/policy')
const { createStore } = require('../bot_impl/life/store')
const { createRuntime } = require('../bot_impl/life/runtime')
const { createRuntime: controller } = require('../bot_impl/controller/runtime')
const { feedCat } = require('../bot_impl/controller/feed-cat')
const actions = require('../bot_impl/actions')
const flush = () => new Promise(resolve => setImmediate(resolve))
const home = { x: 0, y: 64, z: 0, dimension: 'overworld' }
const candidate = x => ({ position: { x, y: 64, z: 0 }, distance: Math.abs(x), recentFailure: false })
const facts = () => ({ position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', health: 20, food: 20, timeOfDay: 6000, busy: false, cats: [], fish: false, candidates: [candidate(8), candidate(-7)], hostiles: 0 })
const document = () => ({ enabled: true, home, maxRadius: 32, wanderIntervalMs: 20000, feedCooldownMs: 600000, feedAttempts: [], visits: [], failures: [] })
function harness (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-life-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = 10000
  const state = {}
  const file = path.join(dir, 'life.json')
  const store = createStore({ state, file, worldId: 'test', now: () => now })
  const f = facts()
  let resolve
  let calls = 0
  const control = controller({ state, now: () => now, driver: { busy () {}, isBusy: () => false, hazard: () => null, stop () {}, facts: () => f, action: () => { calls++; return new Promise(r => { resolve = r }) } } })
  const driver = { controller: () => control, facts: () => f, candidates: () => f.candidates }
  const runtime = createRuntime({ state, store, driver, now: () => now })
  t.after(() => runtime.dispose())
  return { state, file, store, f, control, runtime, driver, time: v => { now = v }, now: () => now, finish: () => resolve({ ok: true }), calls: () => calls }
}
test('day/night priorities, low health, dimensions and explicit home boundary', () => {
  const d = document(); const f = facts()
  assert.equal(decide(d, f, 10000).activity, 'wandering')
  f.timeOfDay = 12000
  assert.equal(decide(d, f, 10000).activity, 'resting')
  f.position.x = 10
  assert.equal(decide(d, f, 10000).activity, 'returning')
  f.health = 6
  assert.equal(decide(d, f, 10000).reason, 'survival_priority')
  f.health = 20; f.dimension = 'the_nether'
  assert.equal(decide(d, f, 10000).reason, 'home_dimension_mismatch')
  f.dimension = 'overworld'; f.position.x = 100
  assert.equal(decide(d, f, 10000).reason, 'outside_home_area')
  f.position.x = 0; f.timeOfDay = null
  assert.equal(decide(d, f, 10000).reason, 'time_unavailable')
})
test('cat UUID cooldown, night priority, failed routes and visit ranking', () => {
  const d = document(); const f = facts()
  f.fish = true; f.cats = [{ uuid: 'cat-1', position: { x: 3, y: 64, z: 0 } }]
  assert.equal(decide(d, f, 10000).activity, 'feeding')
  d.feedAttempts.push({ uuid: 'cat-1', at: 10000 })
  assert.equal(decide(d, f, 70000).activity, 'wandering')
  assert.equal(decide(d, f, 610001).activity, 'feeding')
  f.timeOfDay = 13000
  assert.equal(decide(d, f, 610001).activity, 'resting')
  f.timeOfDay = 0; f.fish = false
  d.visits.push({ position: candidate(8).position, dimension: f.dimension, at: 0 })
  assert.equal(decide(d, f, 10000).target.x, -7)
  d.failures.push({ position: candidate(-7).position, dimension: f.dimension, at: 9000 })
  assert.equal(decide(d, f, 10000).target.x, 8)
  f.candidates = [candidate(100)]
  assert.equal(decide(d, f, 10000).reason, 'no_safe_route')
})
test('disabled by default, preview/dry do not save, schedule or call write', async t => {
  const h = harness(t)
  const before = JSON.stringify(h.store.document())
  h.runtime.tick()
  assert.equal(h.runtime.status().data.preview.activity, 'wandering')
  assert.equal(h.runtime.status().data.preview.hypothetical, true)
  assert.equal(JSON.stringify(h.store.document()), before)
  assert.equal(fs.existsSync(h.file), false)
  const a = actions.install({ state: { lifeApi: { configure () { throw Error('dry executed mutation') }, yield () { throw Error('dry yielded control') } } } })
  assert.equal((await a.dry('life_configure', { op: 'enable', args: { maxRadius: 32 } })).ok, true)
  assert.equal((await a.dry('life_configure', { op: 'enable', args: { maxRadius: -1 } })).ok, false)
  assert.equal(h.state.controller.lease, null)
})
test('night interrupts a wander and starts homeward task; late results cannot advance it', async t => {
  const h = harness(t)
  assert.equal(h.runtime.configure('enable').ok, true)
  h.time(15000); h.runtime.tick(); h.control.tick(); await flush()
  const first = h.state.life.runtime.session.taskId
  assert.equal(h.calls(), 1)
  h.f.position.x = 8; h.f.timeOfDay = 12000
  h.runtime.tick()
  const second = h.state.life.runtime.session.taskId
  assert.notEqual(first, second)
  assert.equal(h.state.controller.tasks.find(t => t.id === first).status, 'canceled')
  assert.equal(h.state.life.runtime.activity, 'returning')
  h.finish(); await flush()
  assert.equal(h.state.controller.tasks.find(t => t.id === second).node, 'move')
  h.runtime.yield('player_action')
  assert.equal(h.state.controller.lease, null)
  assert.equal(h.state.life.runtime.session, null)
})
test('completed/failed tasks release leases, remember evidence, and back off', async t => {
  const h = harness(t)
  h.runtime.configure('enable'); h.time(15000); h.runtime.tick(); h.control.tick(); await flush()
  h.f.position.x = 8; h.finish(); await flush(); h.control.tick(); h.runtime.tick()
  assert.equal(h.state.controller.lease, null)
  assert.equal(h.store.document().visits.length, 1)
  assert.equal(h.state.controller.behaviors.length, 0)
  h.time(35000); h.runtime.tick()
  const current = h.state.life.runtime.session
  h.control.write('task.cancel', { ...current.auth, taskId: current.taskId }); h.runtime.tick()
  assert.equal(h.store.document().failures.length, 1)
  assert.equal(h.state.life.runtime.nextAt, 95000)
})
test('feeding attempt survives reload/restart; emergency stop persists disabled', async t => {
  const h = harness(t)
  h.f.fish = true; h.f.cats = [{ uuid: 'persistent-cat', position: candidate(3).position }]
  h.runtime.configure('enable'); h.time(15000); h.runtime.tick()
  assert.equal(h.store.document().feedAttempts.length, 1)
  h.runtime.dispose()
  const restartedState = {}
  const restarted = createStore({ state: restartedState, file: h.file, worldId: 'test', now: h.now })
  assert.equal(restarted.document().enabled, true)
  assert.equal(decide(restarted.document(), h.f, 15000).activity, 'wandering')
  const next = createRuntime({ state: h.state, store: h.store, driver: h.driver, now: h.now })
  next.stop('emergency_stop'); next.dispose()
  const final = createStore({ state: {}, file: h.file, worldId: 'test' })
  assert.equal(final.document().enabled, false)
})
test('corrupt persistence and write failure fail closed', t => {
  const h = harness(t)
  fs.writeFileSync(h.file, '{broken')
  const bad = createStore({ state: {}, file: h.file, worldId: 'test' })
  assert.ok(bad.error()); assert.equal(bad.commit(d => { d.enabled = true }).ok, false)
  assert.equal(fs.readFileSync(h.file, 'utf8'), '{broken')
  fs.unlinkSync(h.file); fs.mkdirSync(h.file)
  assert.equal(h.runtime.configure('enable').ok, false)
  assert.equal(h.store.document().enabled, false)
  h.time(30000); h.runtime.tick()
  assert.equal(h.state.controller.lease, null)
})
function catBot () {
  const cat = { uuid: 'cat', name: 'cat', position: new Vec3(1, 64, 0) }
  const item = { name: 'salmon', count: 2 }
  let uses = 0
  const bot = { entities: { 1: cat }, entity: { position: new Vec3(0, 64, 0), height: 1.62 }, inventory: { items: () => [item] },
    world: { raycast: () => null }, equip: async () => { bot.heldItem = item }, lookAt: async () => {}, useOn () { uses++; item.count-- } }
  return { bot, cat, uses: () => uses }
}
test('feeding confirms consumption once; stale/out-of-reach/occluded cats are not fed', async () => {
  const h = catBot(); const state = {}
  h.bot.world.raycast = (eye, direction, range) => { assert.ok(range > 1.5); assert.ok(Math.abs(direction.norm() - 1) < 0.001); return null }
  assert.equal((await feedCat(h.bot, state, { uuid: 'cat' }, { canceled: false })).consumed, 1)
  assert.equal(h.uses(), 1); assert.equal(state.holdItemLock, null)
  h.cat.position.x = 5
  assert.equal((await feedCat(h.bot, state, { uuid: 'cat' }, { canceled: false })).ok, false)
  h.cat.position.x = 1; h.bot.world.raycast = () => ({ name: 'stone' })
  assert.equal((await feedCat(h.bot, state, { uuid: 'cat' }, { canceled: false })).error, 'cat_not_visible')
  assert.equal(h.uses(), 1)
})
test('cancel during equip never sends interaction or leaves a hand lock', async () => {
  const h = catBot(); const state = {}; const cancellation = { canceled: false }
  let equipped
  h.bot.equip = () => new Promise(resolve => { equipped = resolve })
  const pending = feedCat(h.bot, state, { uuid: 'cat' }, cancellation)
  cancellation.canceled = true; equipped(); await pending
  assert.equal(h.uses(), 0); assert.equal(state.holdItemLock, null)
})
test('controller does not replay feeding after survival interruption', async () => {
  let hazard = null; let resolve; let calls = 0
  const state = {}
  const api = controller({ state, driver: { busy () {}, isBusy: () => false, hazard: () => hazard, stop () {}, facts: () => ({}), action: () => { calls++; return new Promise(r => { resolve = r }) } } })
  const lease = api.write('session.acquire', { controllerId: 'test', ttlMs: 10000 })
  const auth = { leaseId: lease.leaseId, epoch: lease.epoch }
  api.write('behavior.install', { ...auth, behavior: { id: 'feed', revision: '1', entry: 'feed', nodes: { feed: { type: 'action', action: 'feed_cat', args: { uuid: 'cat' }, next: 'end', timeoutMs: 4000 }, end: { type: 'end' } } } })
  api.write('task.start', { ...auth, requestId: 'r', behaviorId: 'feed', revision: '1', timeoutMs: 5000 })
  api.tick(); await flush(); hazard = 'low_health'; api.tick()
  hazard = null; resolve({ ok: true }); await flush(); api.tick()
  assert.equal(calls, 1); assert.equal(state.controller.tasks[0].reason, 'mutation_interrupted_by_hazard')
  api.dispose()
})
test('manual action preempts life while invalid/dry inputs leave it alone', async t => {
  const h = harness(t)
  h.state.lifeApi = h.runtime
  h.runtime.configure('enable'); h.time(15000); h.runtime.tick()
  let said = null
  const a = actions.install({ state: h.state, chat: text => { said = text } })
  assert.equal((await a.run('say', { text: 123 })).ok, false)
  assert.ok(h.state.controller.lease)
  assert.equal((await a.dry('say', { text: 'hello' })).ok, true)
  assert.ok(h.state.controller.lease)
  assert.equal((await a.run('say', { text: 'hello' })).ok, true)
  assert.equal(said, 'hello'); assert.equal(h.state.controller.lease, null)
  assert.equal(h.state.life.runtime.nextAt, 45000)
})
test('reload after controller revocation reclaims orphan versions without replaying old tasks', t => {
  const h = harness(t)
  h.runtime.configure('enable'); h.time(15000); h.runtime.tick()
  const old = h.state.life.runtime.session.taskId
  h.control.stop('reload'); h.runtime.dispose()
  assert.equal(h.state.controller.behaviors.length, 1)
  const next = createRuntime({ state: h.state, store: h.store, driver: h.driver, now: h.now })
  h.time(20000); next.tick()
  assert.equal(h.state.controller.behaviors.length, 1)
  assert.notEqual(h.state.life.runtime.session.taskId, old)
  assert.equal(h.state.controller.tasks.find(t => t.id === old).status, 'canceled')
  next.dispose()
})
