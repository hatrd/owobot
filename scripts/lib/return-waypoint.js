// Choose the furthest nearby historical waypoint with a fresh successful dry path.
async function selectReturnWaypoint (route, next, preview, lookback = 8) {
  const attempts = []
  for (let index = Math.max(0, next - lookback); index <= next; index++) {
    const p = route[index].from
    const target = { x: p.x + 0.5, y: p.y, z: p.z + 0.5, range: 0.5 }
    const result = await preview(target)
    const plan = result?.data?.plan
    attempts.push({ index, status: plan?.status || result?.error || 'unavailable' })
    if (result?.ok && plan?.status === 'success') return { ok: true, index, target, attempts }
  }
  return { ok: false, error: 'return_route_unreachable', attempts }
}
module.exports = { selectReturnWaypoint }
async function selectTravelAction (actions, index, preview, lookahead = 4, excluded = new Set()) {
  if (actions[index].action !== 'goto') return { ok: true, index, action: actions[index], attempts: [] }
  let last = index
  while (last + 1 < actions.length && last - index < lookahead && actions[last + 1].action === 'goto') last++
  const attempts = []
  for (let i = last; i >= index; i--) {
    if (excluded.has(i)) continue
    const result = await preview(actions[i].args)
    const status = result?.data?.plan?.status || result?.error || 'unavailable'
    attempts.push({ index: i, status })
    if (result?.ok && status === 'success') return { ok: true, index: i, action: actions[i], attempts }
  }
  return { ok: false, error: 'travel_route_unreachable', attempts }
}
module.exports.selectTravelAction = selectTravelAction

async function performTravel (actions, index, preview, execute) {
  const excluded = new Set(), attempts = []
  const retryable = new Set(['navigation_no_path', 'navigation_search_timeout', 'navigation_stalled'])
  for (let attempt = 0; attempt < 3; attempt++) {
    const selected = await selectTravelAction(actions, index, preview, 4, excluded)
    if (!selected.ok) return { ...selected, executions: attempts }
    const result = await execute(selected.action)
    attempts.push({ index: selected.index, ok: result.ok, reason: result.task?.reason })
    if (result.ok) return { ok: true, selected, result, executions: attempts }
    if (selected.action.action !== 'goto' || !retryable.has(result.task?.reason)) return { ok: false, error: result.task?.reason || 'travel_failed', selected, result, executions: attempts }
    if (selected.index > index) excluded.add(selected.index)
  }
  return { ok: false, error: 'travel_replanning_exhausted', executions: attempts }
}
module.exports.performTravel = performTravel
