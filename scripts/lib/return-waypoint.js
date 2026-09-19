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
