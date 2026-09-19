const test = require('node:test'), assert = require('node:assert/strict')
const { selectReturnWaypoint } = require('../scripts/lib/return-waypoint')
const route = Array.from({ length: 12 }, (_, x) => ({ from: { x, y: 10, z: 0 } }))
test('return connects to an earlier reachable waypoint without visiting damaged intermediate floors', async () => {
  const result = await selectReturnWaypoint(route, 11, async p => ({ ok: true, data: { plan: { status: p.x === 5.5 ? 'success' : 'noPath' } } }))
  assert.equal(result.index, 5)
  assert.equal(result.attempts[0].index, 3)
  assert.equal(result.target.x, 5.5)
})
test('partial or timed-out navigation evidence never authorizes skipping waypoints', async () => {
  const result = await selectReturnWaypoint(route, 2, async () => ({ ok: true, data: { plan: { status: 'partial' } } }))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'return_route_unreachable')
  assert.equal(result.attempts.length, 3)
})
test('surface-route replanning skips stale land points but never skips a water transition', async () => {
  const { selectTravelAction } = require('../scripts/lib/return-waypoint')
  const actions = [0, 1, 2].map(x => ({ action: 'goto', args: { x, y: 10, z: 0 } }))
  actions.push({ action: 'surface_travel', args: { x: 3, y: 10, z: 0 } }, { action: 'goto', args: { x: 4, y: 10, z: 0 } })
  const calls = []
  const result = await selectTravelAction(actions, 0, async p => { calls.push(p.x); return { ok: true, data: { plan: { status: 'success' } } } })
  assert.equal(result.index, 2)
  assert.deepEqual(calls, [2])
  const water = await selectTravelAction(actions, 3, () => { throw Error('must not skip water') })
  assert.equal(water.index, 3)
})
test('live navigation failure triggers fresh dry planning and a nearer route anchor', async () => {
  const { performTravel } = require('../scripts/lib/return-waypoint')
  const actions = [0, 1].map(x => ({ action: 'goto', args: { x, y: 10, z: 0 } }))
  const calls = [], previews = []
  const result = await performTravel(actions, 0, async p => { previews.push(p.x); return { ok: true, data: { plan: { status: 'success' } } } }, async a => {
    calls.push(a.args.x); return { ok: a.args.x === 0, task: { reason: a.args.x === 0 ? 'completed' : 'navigation_no_path' } }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [1, 0]); assert.deepEqual(previews, [1, 0])
})
test('cancellation and water failures are never automatically replayed', async () => {
  const { performTravel } = require('../scripts/lib/return-waypoint')
  for (const action of ['goto', 'surface_travel']) {
    let calls = 0
    const result = await performTravel([{ action, args: {} }], 0, async () => ({ ok: true, data: { plan: { status: 'success' } } }), async () => { calls++; return { ok: false, task: { reason: 'canceled' } } })
    assert.equal(result.ok, false); assert.equal(calls, 1)
  }
})
