const { randomUUID } = require('crypto')
const { decide } = require('./policy')
const { distance } = require('../exploration/terrain')
const { validate } = require('./contract')
const clone = value => JSON.parse(JSON.stringify(value))
const OWNER = 'autonomous-life'
function createRuntime ({ state, store, driver, now = Date.now, log = () => {} }) {
  const s = state.life.runtime = { activity: 'waiting', reason: 'starting', nextAt: now() + 5000, session: null, events: [], lastResult: null }
  let disposed = false
  let connected = true
  function transition (activity, reason, extra = {}) {
    if (s.activity === activity && s.reason === reason && !Object.keys(extra).length) return
    s.activity = activity; s.reason = reason
    const event = { at: now(), activity, reason, ...clone(extra) }
    s.events.push(event); s.events = s.events.slice(-64)
    log(event)
  }
  function release (reason) {
    const session = s.session
    s.session = null
    if (!session) return
    const api = driver.controller()
    if (!api) return
    if (session.taskId) api.write('task.cancel', { ...session.auth, taskId: session.taskId })
    if (session.behavior) api.write('behavior.remove', { ...session.auth, ...session.behavior })
    api.write('session.release', session.auth)
    transition('waiting', reason)
  }
  function yieldControl (reason = 'manual_control') {
    release(reason)
    s.nextAt = now() + 30000
    transition('waiting', reason)
  }
  function configure (op, args = {}) {
    const checked = validate(op, args)
    if (!checked.ok || op === 'status') return checked.ok ? { ok: false, error: 'write_operation_required' } : checked
    if (disposed) return { ok: false, error: 'life_unavailable' }
    release('configuration_changed')
    const facts = driver.facts()
    if (op !== 'disable' && !facts.position) return { ok: false, error: 'not_spawned' }
    const result = store.commit(doc => {
      if (op === 'disable') doc.enabled = false
      else {
        if (op === 'set_home' || args.home || !doc.home) {
          doc.home = { ...(args.home || facts.position), dimension: facts.dimension }
          doc.visits = []; doc.failures = []
        }
        for (const k of ['maxRadius', 'wanderIntervalMs', 'feedCooldownMs']) if (args[k] !== undefined) doc[k] = args[k]
        if (op === 'enable') doc.enabled = true
      }
    })
    s.nextAt = now() + 5000
    transition('waiting', result.ok ? op : result.error)
    return result
  }
  function status () {
    const facts = driver.facts()
    const doc = store.document()
    const previewDoc = { ...doc, enabled: true, home: doc.home || (facts.position && { ...facts.position, dimension: facts.dimension }) }
    const preview = decide(previewDoc, { ...facts, candidates: driver.candidates() }, now())
    return { ok: !store.error(), error: store.error(), data: { schemas: require('./contract').schemas, config: clone(doc), activity: s.activity, reason: s.reason, nextAt: s.nextAt, taskId: s.session?.taskId || null, lastResult: clone(s.lastResult), events: clone(s.events.slice(-12)), preview: { ...preview, hypothetical: !doc.enabled, homeAssumed: !doc.home } } }
  }
  function tick () {
    if (disposed || !connected) return
    const doc = store.document()
    if (store.error() || !doc.enabled) { release('disabled'); transition('waiting', store.error() ? 'storage_error' : 'disabled'); return }
    const facts = driver.facts()
    // Urgent priorities are evaluated even during a move and during the idle cooldown.
    const priority = decide(doc, { ...facts, candidates: [], cats: [], fish: false }, now())
    if (s.session) {
      const session = s.session
      const task = driver.controller()?.read('status', { taskId: session.taskId }).tasks?.[0]
      if (!task || ['succeeded', 'failed', 'canceled'].includes(task.status)) {
        s.lastResult = task ? { status: task.status, reason: task.reason, result: task.lastResult } : { status: 'canceled', reason: 'controller_replaced' }
        const saved = store.commit(next => {
          const row = { at: now(), position: facts.position || session.plan.target, dimension: facts.dimension }
          if (task?.status === 'succeeded') next.visits.push(row)
          else next.failures.push({ ...row, position: session.plan.target })
        })
        release(saved.ok ? 'activity_finished' : saved.error)
        s.nextAt = now() + (task?.status === 'succeeded' ? doc.wanderIntervalMs : 60000)
        return
      }
      if ((priority.activity === 'waiting' && priority.reason !== 'no_safe_route') ||
          (['returning', 'resting'].includes(priority.activity) && session.plan.activity !== 'returning')) {
        release(priority.reason)
        s.nextAt = now()
      } else return
    }
    if (priority.activity === 'waiting' && priority.reason !== 'no_safe_route') { transition('waiting', priority.reason); return }
    if (now() < s.nextAt) return
    const plan = decide(doc, { ...facts, candidates: driver.candidates() }, now())
    transition(plan.activity, plan.reason)
    if (!plan.target) { s.nextAt = now() + 5000; return }
    const api = driver.controller()
    if (!api) { transition('waiting', 'controller_unavailable'); return }
    const lease = api.write('session.acquire', { controllerId: OWNER, ttlMs: 60000 })
    if (!lease.ok) { transition('waiting', lease.error); s.nextAt = now() + 5000; return }
    const auth = { leaseId: lease.leaseId, epoch: lease.epoch }
    s.session = { auth, plan, boundaryRadius: Math.max(doc.maxRadius, distance(facts.position, doc.home)) + 2, behavior: null, taskId: null }
    // Controller reload may revoke credentials before our cleanup. Reclaim orphaned versions.
    for (const old of api.read('status').behaviors.filter(b => b.id === OWNER)) api.write('behavior.remove', { ...auth, behaviorId: old.id, revision: old.revision })
    if (plan.catUuid) {
      // Reserve BEFORE sending any interaction. Reload/cancellation never blindly re-feeds.
      const saved = store.commit(next => { next.feedAttempts = next.feedAttempts.filter(a => a.uuid !== plan.catUuid); next.feedAttempts.push({ uuid: plan.catUuid, at: now() }) })
      if (!saved.ok) { release(saved.error); return }
    }
    const behavior = { id: OWNER, revision: randomUUID(), entry: 'move', nodes: {
      move: { type: 'action', action: 'goto', args: { ...plan.target, range: plan.catUuid ? 2 : 1 }, next: plan.catUuid ? 'feed' : 'done', timeoutMs: 45000 },
      ...(plan.catUuid ? { feed: { type: 'action', action: 'feed_cat', args: { uuid: plan.catUuid }, next: 'done', timeoutMs: 4000 } } : {}),
      done: { type: 'end' }
    } }
    const installed = api.write('behavior.install', { ...auth, behavior })
    if (!installed.ok) { release(installed.error); return }
    s.session.behavior = { behaviorId: behavior.id, revision: behavior.revision }
    const task = api.write('task.start', { ...auth, ...s.session.behavior, requestId: randomUUID(), timeoutMs: 50000 })
    if (!task.ok) { release(task.error); return }
    s.session.taskId = task.taskId
    transition(plan.activity, plan.reason, { target: plan.target, taskId: task.taskId, catUuid: plan.catUuid || null })
  }
  function stop (reason) {
    release(reason)
    const result = store.document().enabled ? store.commit(doc => { doc.enabled = false }) : { ok: true }
    transition('waiting', result.ok ? reason : result.error)
    return result
  }
  return {
    tick, status, configure, yield: yieldControl, stop,
    boundary: position => !s.session || distance(position, store.document().home) <= s.session.boundaryRadius,
    connection (ready) { connected = ready; if (!ready) release('connection_ended'); s.nextAt = now() + 5000 },
    dispose () { release('reload'); disposed = true }
  }
}
module.exports = { createRuntime, OWNER }
