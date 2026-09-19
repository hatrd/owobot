const { Vec3 } = require('vec3')
const { body, cell, fluid } = require('./navigation/liquids')
const { planEscape } = require('./navigation/recovery')

function install (bot, { on, state, registerCleanup, log, now = Date.now }) {
  const s = state.autoSwim ||= {}
  s.cfg = { enabled: true, tickMs: 120, ...s.cfg }
  // A hot reload must not replay stale steering or retain a busy contribution.
  if (s.runtime?.ownsBusy) state.externalBusyCount = Math.max(0, (state.externalBusyCount || 0) - 1)
  state.externalBusy = (state.externalBusyCount || 0) > 0
  const r = s.runtime = { active: false, ownsBusy: false, phase: 'idle', route: [], reason: null, startedAt: null, lastProgressAt: null, lastPosition: null, nextPlanAt: 0, visited: 0 }
  let timer
  function own (value) {
    if (r.ownsBusy === value) return
    state.externalBusyCount = Math.max(0, (state.externalBusyCount || 0) + (value ? 1 : -1))
    state.externalBusy = state.externalBusyCount > 0
    r.ownsBusy = value
  }
  function release (phase, reason = null) {
    if (r.ownsBusy) { bot.setControlState('jump', false); bot.setControlState('forward', false) }
    own(false); r.active = false; r.phase = phase; r.reason = reason; r.route = []
  }
  function tick () {
    if (!s.cfg.enabled || !state.hasSpawned || !bot.entity?.position || bot.isSleeping || bot.vehicle) return release('idle')
    const otherBusy = (state.externalBusyCount || 0) > (r.ownsBusy ? 1 : 0) || (state.externalBusy && !r.ownsBusy)
    if (otherBusy || state.holdItemLock || bot.pathfinder?.goal) return release('yielded', 'other_owner')
    const b = body(bot)
    if (!b.inWater && !r.active) return release('idle')
    // Shallow wading is already safe. Deep water stays owned until a supported shore is reached.
    if (b.head === 'dry' && bot.entity.onGround !== false && cell(bot, bot.entity.position).allowed) return release('idle')
    const time = now(); const p = bot.entity.position
    if (!r.active) {
      Object.assign(r, { active: true, phase: 'recovering', reason: null, startedAt: time, lastProgressAt: time, lastPosition: { x: p.x, y: p.y, z: p.z }, nextPlanAt: 0 })
      own(true)
    }
    if (p.distanceTo(new Vec3(r.lastPosition.x, r.lastPosition.y, r.lastPosition.z)) >= 0.4) {
      r.lastProgressAt = time; r.lastPosition = { x: p.x, y: p.y, z: p.z }
    }
    // Reassert from actual controls; another driver may have cleared them.
    bot.setControlState('jump', true); bot.setControlState('sneak', false); bot.setControlState('sprint', false)
    if (time - r.startedAt > 20000 || time - r.lastProgressAt > 8000) {
      r.phase = 'blocked'; r.reason = 'escape_stalled'; r.route = []; bot.setControlState('forward', false); return
    }
    if (time >= r.nextPlanAt) {
      const plan = planEscape(bot)
      r.route = plan.route || []; r.reason = plan.error || null; r.visited = plan.visited; r.nextPlanAt = time + 1000
      r.phase = plan.ok ? plan.kind : 'searching'
    }
    while (r.route.length && Math.hypot(p.x - r.route[0].x, p.z - r.route[0].z) < 0.4 && p.y >= r.route[0].y - 0.25) r.route.shift()
    const target = r.route[0]
    const dx = target ? target.x - p.x : 0; const dz = target ? target.z - p.z : 0
    // Validate the next step again before steering; never swim into stale geometry.
    if (target) {
      const feet = bot.blockAt(new Vec3(target.x, target.y, target.z).floored(), false)
      const head = bot.blockAt(new Vec3(target.x, target.y + 1, target.z).floored(), false)
      if (!feet || !head || feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || [feet, head].some(b => fluid(bot, b).kind === 'lava')) { r.nextPlanAt = 0; r.route = []; bot.setControlState('forward', false); return }
    }
    const forward = Math.hypot(dx, dz) > 0.25
    if (forward) Promise.resolve(bot.look(Math.atan2(-dx, -dz), 0, true)).catch(error => { r.reason = String(error.message || error) })
    bot.setControlState('forward', forward)
  }
  function start () { if (!timer) timer = setInterval(() => { try { tick() } catch (error) { release('failed', String(error.message || error)); log?.error?.('swim recovery', r.reason) } }, Math.max(100, s.cfg.tickMs)) }
  function stop () { if (timer) clearInterval(timer); timer = null; release('stopped') }
  on('spawn', start); on('end', stop); on('agent:stop_all', () => release('stopped'))
  on('cli', ({ cmd, args = [] }) => {
    if (cmd !== 'swim') return
    if (args[0] === 'on') s.cfg.enabled = true
    if (args[0] === 'off') { s.cfg.enabled = false; release('disabled') }
    console.log('[SWIM]', JSON.stringify({ enabled: s.cfg.enabled, ...r }))
  })
  registerCleanup(stop); start()
  return { tick, stop }
}
module.exports = { install }
