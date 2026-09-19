const test = require('node:test')
const assert = require('node:assert/strict')
const { createRuntime } = require('../bot_impl/controller/runtime')
const { validate } = require('../bot_impl/controller/contract')
const actionsMod = require('../bot_impl/actions')
const { render } = require('../bot_impl/controller/view-worker')
const flush = () => new Promise(resolve => setImmediate(resolve))
const behavior = () => ({ id: 'tour', revision: '1', entry: 'walk', nodes: {
  walk: { type: 'action', action: 'goto', args: { x: 1, y: 64, z: 2 }, next: 'end', timeoutMs: 1000 },
  end: { type: 'end' }
} })
function harness () {
  let now = 0
  let hazard = null
  let busy = false
  let done
  let calls = 0
  let stops = 0
  const state = {}
  const driver = { isBusy: () => false, busy: value => { busy = value }, hazard: () => hazard, stop: () => { stops++ }, facts: () => ({ health: 20 }), action: () => { calls++; return new Promise(resolve => { done = resolve }) } }
  const runtime = createRuntime({ state, driver, now: () => now })
  const session = runtime.write('session.acquire', { controllerId: 'test', ttlMs: 10000 })
  const credentials = { leaseId: session.leaseId, epoch: session.epoch }
  const install = b => runtime.write('behavior.install', { ...credentials, behavior: b })
  install(behavior())
  const start = (args = {}) => runtime.write('task.start', { ...credentials, behaviorId: 'tour', revision: '1', requestId: 'r1', timeoutMs: 5000, ...args })
  return { runtime, state, credentials, driver, install, start, now: value => { now = value }, hazard: value => { hazard = value }, resolve: result => done(result), calls: () => calls, stops: () => stops, busy: () => busy }
}
test('reject malformed graphs and mutation payloads before installation', () => {
  const b = behavior(); b.nodes.walk.next = 'missing'
  assert.equal(validate('behavior.validate', { behavior: b }).error, 'invalid_transition')
  b.nodes.walk.next = 'end'; b.nodes.walk.args.dig = true
  assert.equal(validate('behavior.validate', { behavior: b }).error, 'invalid_arguments')
  assert.equal(validate('session.acquire', { controllerId: 'x', ttlMs: 999999 }).ok, false)
})
test('immutable versions, idempotent starts, and actual completion', async () => {
  const h = harness()
  assert.equal(h.install(behavior()).ok, true)
  const changed = behavior(); changed.nodes.walk.args.x = 3
  assert.equal(h.install(changed).error, 'immutable_revision')
  const start = h.start()
  assert.equal(h.start().taskId, start.taskId)
  assert.equal(h.start({ timeoutMs: 6000 }).error, 'request_id_conflict')
  h.runtime.tick(); await flush(); h.runtime.tick()
  assert.equal(h.calls(), 1)
  assert.equal(h.state.controller.tasks[0].status, 'running')
  h.resolve({ ok: true }); await flush(); h.runtime.tick()
  assert.equal(h.state.controller.tasks[0].status, 'succeeded')
})
test('cancel stops driver, retains terminal state and ignores late completion', async () => {
  const h = harness(); const { taskId } = h.start()
  h.runtime.tick(); await flush()
  assert.equal(h.runtime.write('task.cancel', { ...h.credentials, taskId }).ok, true)
  h.resolve({ ok: true }); await flush(); h.runtime.tick()
  assert.equal(h.state.controller.tasks[0].status, 'canceled')
  assert.ok(h.stops() > 0)
})
test('expired leases revoke movement and reject stale renewals', async () => {
  const h = harness(); h.start(); h.runtime.tick(); await flush()
  h.now(10001); h.runtime.tick()
  assert.equal(h.state.controller.lease, null)
  assert.equal(h.busy(), false)
  assert.equal(h.runtime.write('session.renew', { ...h.credentials, ttlMs: 1000 }).error, 'stale_or_invalid_lease')
  h.resolve({ ok: true }); await flush()
  assert.equal(h.state.controller.tasks[0].reason, 'lease_expired')
})
test('emergency suspends, cancels pending work and resumes the same node', async () => {
  const h = harness(); h.start(); h.runtime.tick(); await flush()
  const late = h.resolve
  h.hazard('low_oxygen'); h.runtime.tick()
  assert.equal(h.state.controller.tasks[0].status, 'suspended'); assert.equal(h.busy(), false)
  late({ ok: true }); await flush()
  h.hazard(null); h.runtime.tick(); await flush()
  assert.equal(h.calls(), 2)
  h.resolve({ ok: true }); await flush(); h.runtime.tick()
  assert.equal(h.state.controller.tasks[0].status, 'succeeded')
})
test('node timeout and task deadline terminate instead of leaving a running promise', async () => {
  const h = harness(); h.start(); h.runtime.tick(); await flush()
  h.now(1000); h.runtime.tick()
  assert.equal(h.state.controller.tasks[0].reason, 'node_timeout')
  h.resolve({ ok: true }); await flush()
  const b = behavior(); b.revision = '2'; b.nodes.walk = { type: 'wait', ms: 2000, next: 'end' }
  h.install(b); h.start({ requestId: 'r2', revision: '2', timeoutMs: 500 })
  h.runtime.tick(); h.now(1500); h.runtime.tick()
  assert.equal(h.state.controller.tasks[1].reason, 'deadline_exceeded')
})
test('hot reload revokes leases and retains behaviors/history without replaying actions', async () => {
  const h = harness(); h.start(); h.runtime.tick(); await flush()
  h.runtime.dispose()
  const next = createRuntime({ state: h.state, driver: h.driver, now: () => 100 })
  next.tick(); h.resolve({ ok: true }); await flush()
  assert.equal(h.calls(), 1)
  assert.equal(h.state.controller.lease, null)
  assert.equal(next.read('status').behaviors.length, 1)
  assert.equal(h.state.controller.tasks[0].reason, 'reload')
})
test('read-only queries never acquire control; dry mutation never calls write', async () => {
  const h = harness()
  let writes = 0
  const bot = { state: { controllerApi: { read: h.runtime.read, write: () => { writes++; return { ok: true } } } } }
  const actions = actionsMod.install(bot)
  const result = await actions.dry('controller_write', { op: 'session.acquire', args: { controllerId: 'test', ttlMs: 1000 } })
  assert.equal(result.ok, true); assert.equal(writes, 0)
  assert.equal((await actions.dry('controller_read', { op: 'session.acquire' })).ok, false)
  bot.state.controller = { lease: { id: 'held' } }
  assert.equal((await actions.run('say', { text: 'blocked' })).error, 'controller_busy')
})
test('event cursors report lost history and wait_event ignores older events', () => {
  const h = harness()
  for (let i = 0; i < 300; i++) h.runtime.event('health', { health: 20 })
  const page = h.runtime.read('events.read', { cursor: 0, limit: 10 })
  assert.equal(page.historyLost, true); assert.equal(page.events.length, 10)
  assert.equal(h.state.controller.events.length, 256)
  const b = behavior(); b.revision = 'wait'; b.nodes.walk = { type: 'wait_event', event: 'health', next: 'end', timeoutMs: 1000 }
  h.install(b); h.start({ revision: 'wait' }); h.runtime.tick(); h.runtime.tick()
  assert.equal(h.state.controller.tasks[0].node, 'walk')
  h.runtime.event('health', { health: 19 }); h.runtime.tick(); h.runtime.tick()
  assert.equal(h.state.controller.tasks[0].status, 'succeeded')
})
test('worker creates a bounded valid PNG without accessing the bot', () => {
  const png = render({ grid: new Int16Array(27), size: 3, origin: [-1, -1, -1], eye: [0, 0, 0], yaw: 0, pitch: 0, palette: [null], radius: 1 })
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.readUInt32BE(16), 160)
  assert.equal(png.readUInt32BE(20), 100)
  assert.ok(png.length < 100000)
})
