#!/usr/bin/env node
// Human-operated example controller. AI verification uses --dry only.
const fs = require('fs')
const { randomUUID } = require('crypto')
const { call } = require('./controller-client')
async function main () {
  const [file, ...flags] = process.argv.slice(2)
  if (!file) throw new Error('usage: node scripts/run-behavior.js behavior.json [--dry]')
  const behavior = JSON.parse(fs.readFileSync(file, 'utf8'))
  const checked = await call('behavior.validate', { behavior })
  if (!checked.ok) throw new Error(JSON.stringify(checked))
  if (flags.includes('--dry')) { console.log(JSON.stringify(checked, null, 2)); return }
  let credentials
  let interrupted = false
  const onInterrupt = () => { interrupted = true }
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)
  const must = async (op, args) => {
    const response = await call(op, args)
    if (!response.ok) throw new Error(JSON.stringify(response))
    return response
  }
  try {
    const lease = await must('session.acquire', { controllerId: 'example-controller', ttlMs: 15000 })
    credentials = { leaseId: lease.leaseId, epoch: lease.epoch }
    await must('behavior.install', { ...credentials, behavior })
    const { taskId } = await must('task.start', { ...credentials, requestId: randomUUID(), behaviorId: behavior.id, revision: behavior.revision, timeoutMs: 120000 })
    let cursor = 0
    let renewal = Date.now() + 5000
    while (!interrupted) {
      const events = await must('events.read', { cursor, limit: 100 })
      cursor = events.nextCursor
      for (const event of events.events) if (event.taskId === taskId || event.task?.id === taskId) console.log(JSON.stringify(event))
      const status = await must('status', { taskId })
      const task = status.tasks[0]
      if (['succeeded', 'failed', 'canceled'].includes(task.status)) {
        console.log(JSON.stringify(task, null, 2))
        if (task.status !== 'succeeded') process.exitCode = 1
        break
      }
      if (Date.now() >= renewal) { await must('session.renew', { ...credentials, ttlMs: 15000 }); renewal = Date.now() + 5000 }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (interrupted) await must('task.cancel', { ...credentials, taskId })
  } finally {
    if (credentials) {
      try { await must('session.release', credentials) } catch (error) { console.error('release failed; lease will expire:', error.message) }
    }
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onInterrupt)
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
