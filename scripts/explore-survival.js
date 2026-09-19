#!/usr/bin/env node
// Finite survival/exploration controller. Re-run --resume <missionId> to continue.
// Selection uses explicit terrain/visit/health fields; it does not interpret text.
const { randomUUID } = require('crypto')
const { call, request } = require('./controller-client')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const options = process.argv.slice(2)
const value = (key, fallback) => { const i = options.indexOf(key); return i < 0 ? fallback : options[i + 1] }
const steps = Math.max(1, Math.min(20, Number(value('--steps', 4))))
const maxRadius = Math.max(8, Math.min(128, Number(value('--max-radius', 32))))
const isDry = options.includes('--dry')
const out = (event, data) => console.log(JSON.stringify({ event, at: Date.now(), ...data }))
async function must (op, args = {}) {
  const result = await call(op, args)
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result
}
async function snapshot () {
  return request({ op: 'observe.snapshot', args: { invTop: 2, nearPlayerMax: 4 } })
}
async function main () {
  if (!Number.isInteger(steps) || !Number.isInteger(maxRadius)) throw new Error('invalid_limits')
  let interrupted = false
  const interrupt = () => { interrupted = true }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  let credentials
  let missionId = value('--resume', null)
  let taskId
  let installedBehavior
  let failure
  let renewalAt = 0
  async function renew () {
    if (Date.now() >= renewalAt) { await must('session.renew', { ...credentials, ttlMs: 15000 }); renewalAt = Date.now() + 4000 }
  }
  try {
    const before = await snapshot()
    out('start', { position: before.pos, vitals: before.vitals, missionId, dry: isDry })
    const terrain = await must('observe', { what: 'terrain', radius: 8, max: 12 })
    if (isDry) {
      const memory = await must('memory.recall')
      out('preview', { candidates: terrain.data.candidates, memory: { counts: memory.counts, missions: memory.missions } })
      return
    }
    if (before.vitals.hp < 16 || before.vitals.food < 10) throw new Error('initial_vitals_too_low')
    const lease = await must('session.acquire', { controllerId: 'survival-explorer', ttlMs: 15000 })
    credentials = { leaseId: lease.leaseId, epoch: lease.epoch }
    if (missionId) await must('memory.resume', { ...credentials, missionId })
    else {
      const result = await must('memory.begin', { ...credentials, objective: 'Explore nearby walkable terrain, remember discoveries and stay within the home radius.', maxRadius })
      missionId = result.mission.id
    }
    out('mission', { missionId })
    for (let step = 0; step < steps && !interrupted; step++) {
      await renew()
      await must('memory.checkpoint', { ...credentials, missionId })
      const snap = await snapshot()
      if (snap.vitals.hp < 16 || snap.vitals.food < 10 || snap.nearby.hostiles.count > 0) throw new Error('survival_stop_condition')
      const survey = await must('observe', { what: 'terrain', radius: 8, max: 40 })
      const target = survey.data.candidates.find(c => c.withinMission && !c.recentFailure)
      if (!target) { out('frontier_exhausted', { missionId }); break }
      const behavior = { id: `explore-${missionId}`, revision: randomUUID(), entry: 'move', nodes: {
        move: { type: 'action', action: 'goto', args: { ...target.position, range: 1 }, next: 'done', timeoutMs: 20000 }, done: { type: 'end' }
      } }
      await must('behavior.validate', { behavior })
      await must('behavior.install', { ...credentials, behavior })
      installedBehavior = { behaviorId: behavior.id, revision: behavior.revision }
      const task = await must('task.start', { ...credentials, requestId: randomUUID(), behaviorId: behavior.id, revision: behavior.revision, timeoutMs: 25000, missionId })
      taskId = task.taskId
      out('move', { missionId, taskId, step, target })
      let terminal
      const deadline = Date.now() + 30000
      while (!interrupted && Date.now() < deadline) {
        await renew()
        const status = await must('status', { taskId })
        terminal = status.tasks[0]
        if (['succeeded', 'failed', 'canceled'].includes(terminal.status)) break
        const current = await snapshot()
        if (current.vitals.hp < 16 || current.nearby.hostiles.count > 0) throw new Error('survival_stop_condition')
        await delay(300)
      }
      if (!terminal || terminal.status !== 'succeeded') {
        await must('task.cancel', { ...credentials, taskId })
        throw new Error(`move_not_completed:${terminal?.reason || terminal?.status || 'client_timeout'}`)
      }
      taskId = null
      await must('memory.checkpoint', { ...credentials, missionId })
      out('arrived', { missionId, step, position: (await snapshot()).pos, memory: (await must('memory.recall', { max: 4 })).counts })
      await must('behavior.remove', { ...credentials, ...installedBehavior })
      installedBehavior = null
    }
  } catch (error) { failure = error; out('error', { missionId, error: error.message }); process.exitCode = 1 }
  finally {
    if (credentials) {
      if (taskId) { try { await must('task.cancel', { ...credentials, taskId }) } catch (error) { out('cancel_error', { error: error.message }) } }
      if (missionId) {
        try { await must('memory.checkpoint', { ...credentials, missionId }); await must('memory.pause', { ...credentials, missionId, reason: interrupted ? 'operator_interrupt' : failure ? 'run_failed' : 'step_budget_reached' }) } catch (error) { out('memory_error', { error: error.message }) }
      }
      if (installedBehavior) { try { await must('behavior.remove', { ...credentials, ...installedBehavior }) } catch (error) { out('behavior_cleanup_error', { error: error.message }) } }
      try { await must('session.release', credentials) } catch (error) { out('release_error', { error: error.message }) }
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
    if (missionId) out('resume', { command: `node scripts/explore-survival.js --resume ${missionId} --steps 4` })
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
