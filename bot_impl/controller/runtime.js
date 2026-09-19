const { randomUUID, createHash } = require('crypto')
const contract = require('./contract')
const copy = x => JSON.parse(JSON.stringify(x))
const terminal = t => ['succeeded', 'failed', 'canceled'].includes(t.status)
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex')

// All replayable facts live in state.controller; closures only hold replaceable drivers.
function createRuntime ({ state, driver, now = Date.now, log = () => {} }) {
  const s = state.controller ||= { epoch: 0, lease: null, behaviors: [], tasks: [], events: [], sequence: 0, activeTaskId: null }
  s.runtimeId = randomUUID()
  let pending = null
  let disposed = false
  function emit (type, data = {}) {
    const event = { sequence: ++s.sequence, at: now(), type, ...copy(data) }
    s.events.push(event)
    if (s.events.length > 256) s.events.shift()
    log(event)
  }
  const active = () => s.tasks.find(t => t.id === s.activeTaskId)
  function finish (t, status, reason) {
    if (!t || terminal(t)) return
    if (pending?.taskId === t.id) { pending.cancel(); pending = null }
    driver.stop()
    Object.assign(t, { status, reason, finishedAt: now() })
    s.activeTaskId = null
    emit('task.finished', { taskId: t.id, status, reason })
  }
  function revoke (reason) {
    finish(active(), 'canceled', reason)
    if (s.lease) emit('session.released', { controllerId: s.lease.controllerId, reason })
    s.lease = null
    driver.busy(false)
  }
  function expire () {
    if (s.lease && s.lease.expiresAt <= now()) revoke('lease_expired')
  }
  function authenticate (args) {
    expire()
    return s.lease && args.leaseId === s.lease.id && args.epoch === s.lease.epoch
  }
  function read (op, args = {}) {
    const checked = contract.validate(op, args)
    if (!checked.ok) return checked
    if (!contract.readOps.includes(op)) return { ok: false, error: 'read_only_operation_required' }
    if (op === 'memory.recall') return driver.memoryRead?.(args) || { ok: false, error: 'memory_unavailable' }
    if (op === 'schema') return { ok: true, protocolVersion: 1, schemas: copy(contract.schemas), behaviorSchema: copy(contract.behaviorSchema), limits: { tasks: 100, behaviors: 64, events: 256, resultBytes: 16384 }, view: { what: 'view', format: 'image/png', renderer: 'voxel', textured: false } }
    if (op === 'behavior.validate') return { ok: true, hash: hash(args.behavior), nodes: Object.keys(args.behavior.nodes).length }
    if (op === 'events.read') {
      const cursor = args.cursor || 0
      const events = s.events.filter(e => e.sequence > cursor).slice(0, args.limit || 50)
      return { ok: true, events: copy(events), nextCursor: events.at(-1)?.sequence ?? cursor, oldestCursor: s.events[0]?.sequence ?? s.sequence, historyLost: cursor < (s.events[0]?.sequence || 1) - 1 }
    }
    const tasks = args.taskId ? s.tasks.filter(t => t.id === args.taskId) : s.tasks.slice(-10)
    if (args.taskId && !tasks.length) return { ok: false, error: 'task_not_found' }
    const lease = s.lease && { controllerId: s.lease.controllerId, epoch: s.lease.epoch, expiresAt: s.lease.expiresAt, expired: s.lease.expiresAt <= now() }
    return { ok: true, at: now(), epoch: s.epoch, runtimeId: s.runtimeId, lease, activeTaskId: s.activeTaskId, tasks: copy(tasks), behaviors: s.behaviors.map(({ id, revision, hash }) => ({ id, revision, hash })) }
  }
  function write (op, args = {}) {
    if (disposed) return { ok: false, error: 'runtime_unavailable' }
    const checked = contract.validate(op, args)
    if (!checked.ok) return checked
    if (!contract.writeOps.includes(op)) return { ok: false, error: 'write_operation_required' }
    expire()
    if (op === 'session.acquire') {
      if (s.lease) return { ok: false, error: 'controller_busy', expiresAt: s.lease.expiresAt }
      if (driver.isBusy()) return { ok: false, error: 'bot_busy' }
      s.lease = { id: randomUUID(), epoch: ++s.epoch, controllerId: args.controllerId, expiresAt: now() + args.ttlMs }
      driver.busy(true)
      emit('session.acquired', { controllerId: args.controllerId, epoch: s.epoch, expiresAt: s.lease.expiresAt })
      return { ok: true, leaseId: s.lease.id, epoch: s.epoch, expiresAt: s.lease.expiresAt }
    }
    if (!authenticate(args)) return { ok: false, error: 'stale_or_invalid_lease' }
    if (op === 'memory.pause' && active()?.missionId === args.missionId) finish(active(), 'canceled', 'mission_paused')
    if (['memory.begin', 'memory.resume', 'memory.pause', 'memory.checkpoint'].includes(op)) return driver.memoryWrite?.(op, args) || { ok: false, error: 'memory_unavailable' }
    if (op === 'session.renew') { s.lease.expiresAt = now() + args.ttlMs; emit('session.renewed', { epoch: s.epoch, expiresAt: s.lease.expiresAt }); return { ok: true, expiresAt: s.lease.expiresAt } }
    if (op === 'session.release') { revoke('released'); return { ok: true } }
    if (op === 'behavior.remove') {
      const index = s.behaviors.findIndex(b => b.id === args.behaviorId && b.revision === args.revision)
      if (index < 0) return { ok: false, error: 'behavior_not_found' }
      if (active()?.hash === s.behaviors[index].hash) return { ok: false, error: 'behavior_in_use' }
      s.behaviors.splice(index, 1)
      emit('behavior.removed', { id: args.behaviorId, revision: args.revision })
      return { ok: true }
    }
    if (op === 'behavior.install') {
      const b = args.behavior
      const digest = hash(b)
      const existing = s.behaviors.find(x => x.id === b.id && x.revision === b.revision)
      if (existing) return existing.hash === digest ? { ok: true, hash: digest } : { ok: false, error: 'immutable_revision' }
      if (s.behaviors.length >= 64) return { ok: false, error: 'behavior_limit' }
      s.behaviors.push({ ...copy(b), hash: digest })
      emit('behavior.installed', { id: b.id, revision: b.revision, hash: digest, behavior: b })
      return { ok: true, hash: digest }
    }
    if (op === 'task.cancel') {
      const task = s.tasks.find(t => t.id === args.taskId)
      if (!task) return { ok: false, error: 'task_not_found' }
      if (task.epoch !== args.epoch) return { ok: false, error: 'task_owner_mismatch' }
      finish(task, 'canceled', 'requested')
      return { ok: true, task: copy(task) }
    }
    const requestHash = hash({ behaviorId: args.behaviorId, revision: args.revision, timeoutMs: args.timeoutMs, missionId: args.missionId || null })
    const previous = s.tasks.find(t => t.epoch === args.epoch && t.requestId === args.requestId)
    if (previous) return previous.requestHash === requestHash ? { ok: true, taskId: previous.id, duplicate: true } : { ok: false, error: 'request_id_conflict' }
    if (active()) return { ok: false, error: 'task_busy' }
    const behavior = s.behaviors.find(b => b.id === args.behaviorId && b.revision === args.revision)
    if (!behavior) return { ok: false, error: 'behavior_not_found' }
    if (args.missionId && !driver.canStartMission?.(args.missionId, behavior)) return { ok: false, error: 'invalid_mission_or_target' }
    // Refuse once full rather than evicting request IDs and accidentally executing a retry twice.
    if (s.tasks.filter(t => t.epoch === args.epoch).length >= 100) return { ok: false, error: 'session_task_limit' }
    while (s.tasks.length >= 100) s.tasks.splice(s.tasks.findIndex(t => t.epoch !== args.epoch), 1)
    const t = { id: randomUUID(), epoch: args.epoch, requestId: args.requestId, requestHash, missionId: args.missionId || null, behaviorId: behavior.id, revision: behavior.revision, hash: behavior.hash, node: behavior.entry, status: 'running', createdAt: now(), deadline: now() + args.timeoutMs, nodeStartedAt: null, steps: 0, lastResult: null }
    s.tasks.push(t)
    s.activeTaskId = t.id
    emit('task.started', { task: t })
    return { ok: true, taskId: t.id }
  }
  function advance (t, next, result) {
    if (result !== undefined) {
      const encoded = JSON.stringify(result)
      t.lastResult = { node: t.node, data: encoded.length > 16384 ? { truncated: true, bytes: encoded.length } : copy(result) }
    }
    emit('task.transition', { taskId: t.id, from: t.node, to: next, result: result === undefined ? null : t.lastResult })
    t.node = next
    t.nodeStartedAt = null
  }
  function tick () {
    if (disposed) return
    expire()
    const t = active()
    if (!t) {
      if (s.lease) driver.busy(!driver.hazard())
      return
    }
    if (now() >= t.deadline) return finish(t, 'failed', 'deadline_exceeded')
    const hazard = driver.hazard()
    if (hazard) {
      if (t.status !== 'suspended') {
        if (pending) { pending.cancel(); pending = null }
        driver.stop()
        t.status = 'suspended'
        t.nodeStartedAt = null
        driver.busy(false)
        emit('task.suspended', { taskId: t.id, reason: hazard })
      }
      return
    }
    if (t.status === 'suspended') {
      if (driver.isBusy()) return
      t.status = 'running'
      driver.busy(true)
      emit('task.resumed', { taskId: t.id })
    }
    const b = s.behaviors.find(b => b.hash === t.hash)
    const node = b.nodes[t.node]
    if (t.nodeStartedAt === null) {
      if (++t.steps > 1000) return finish(t, 'failed', 'step_limit')
      t.nodeStartedAt = now()
      t.eventCursor = s.sequence
      emit('task.node', { taskId: t.id, node: t.node, at: t.nodeStartedAt })
    }
    if (node.type === 'end') return finish(t, 'succeeded', 'completed')
    if (node.type === 'wait') { if (now() - t.nodeStartedAt >= node.ms) advance(t, node.next); return }
    if (node.type === 'branch') {
      const a = driver.facts()[node.condition.field]
      const v = node.condition.value
      const operators = { lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b, gte: (a, b) => a >= b, gt: (a, b) => a > b }
      if (!Number.isFinite(a)) return finish(t, 'failed', 'missing_condition_field')
      advance(t, operators[node.condition.operator](a, v) ? node.yes : node.no)
      return
    }
    if (now() - t.nodeStartedAt >= node.timeoutMs) return finish(t, 'failed', 'node_timeout')
    if (node.type === 'wait_event') {
      const event = s.events.find(e => e.sequence > t.eventCursor && e.type === 'world.event' && e.event === node.event)
      if (event) advance(t, node.next, event)
      return
    }
    if (pending) return
    const operation = { taskId: t.id, canceled: false, cancel () { this.canceled = true; driver.stop() } }
    pending = operation
    Promise.resolve().then(() => {
      if (!operation.canceled) return driver.action(node.action, copy(node.args), operation)
    }).then(result => {
      if (operation.canceled || disposed || pending !== operation) return
      pending = null
      if (result?.ok !== true) return finish(t, 'failed', result?.error || 'action_failed')
      advance(t, node.next, result)
    }).catch(error => {
      if (operation.canceled || disposed || pending !== operation) return
      pending = null
      finish(t, 'failed', String(error.message || error))
    })
  }
  function dispose (reason = 'reload') { revoke(reason); disposed = true }
  // A driver reload or reconnect must never replay an uncertain in-flight action.
  if (s.lease || active()) revoke('runtime_replaced')
  return { read, write, tick, dispose, stop: (reason = 'emergency_stop') => revoke(reason), event: (event, data) => emit('world.event', { event, data }) }
}
module.exports = { createRuntime }
