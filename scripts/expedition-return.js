#!/usr/bin/env node
// Retrace the recorded mine route. Surface travel and final home verification are separate.
const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')
const { call } = require('./controller-client')
const { session, checked, makeBehavior } = require('./cerebellum')
const { selectReturnWaypoint } = require('./lib/return-waypoint')
async function main () {
  const flags = Object.fromEntries(process.argv.slice(2).map(v => v.replace(/^--/, '').split('=')))
  const steps = Number(flags.steps || 40)
  if (!Number.isInteger(steps) || steps < 1 || steps > 80) throw Error('invalid_steps')
  const world = checked(await call('knowledge.query', { kind: 'home', max: 1 })).worldId
  const expedition = JSON.parse(fs.readFileSync(path.resolve('data', `diamond-expedition-${world}.json`), 'utf8'))
  if (expedition.world !== world || !Array.isArray(expedition.route) || !expedition.route.length) throw Error('missing_world_route')
  const routeHash = createHash('sha256').update(JSON.stringify(expedition.route)).digest('hex')
  const file = path.resolve('data', `diamond-return-${world}.json`)
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, world, routeHash, next: expedition.route.length - 1, phase: 'prepared' }
  if (doc.world !== world || doc.routeHash !== routeHash) throw Error('return_route_changed')
  const observe = async () => checked(await call('observe', { what: 'excavation', radius: 4, max: 1 })).data
  const save = () => {
    doc.updatedAt = Date.now()
    const temp = `${file}.${randomUUID()}.tmp`
    const fd = fs.openSync(temp, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(doc)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, file)
  }
  if (Object.hasOwn(flags, 'dry')) {
    if (doc.next < 0) { console.log(JSON.stringify({ ok: true, phase: 'mine_route_returned' })); return }
    const selected = await selectReturnWaypoint(expedition.route, doc.next, target => call('observe', { what: 'navigation', ...target }))
    if (!selected.ok) throw Object.assign(Error(selected.error), { result: selected })
    checked(await call('behavior.validate', { behavior: makeBehavior('goto', selected.target, 20000) }))
    console.log(JSON.stringify({ ok: true, dry: true, next: doc.next, ...selected }))
    return
  }
  const s = await session('expedition-return')
  const stop = () => s.close().finally(() => process.exit(130))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    for (let n = 0; n < steps && doc.next >= 0; n++) {
      const snapshot = await observe()
      if (snapshot.vitals.health < 16 || snapshot.vitals.food < 10) throw Error('unsafe_vitals')
      const expected = expedition.route[doc.next].target
      const p = snapshot.position
      if (Math.hypot(p.x - expected.x - 0.5, p.z - expected.z - 0.5) > 16 || Math.abs(p.y - expected.y) > 12) throw Error('return_position_mismatch')
      const selected = await selectReturnWaypoint(expedition.route, doc.next, target => call('observe', { what: 'navigation', ...target }))
      if (!selected.ok) { doc.phase = 'needs_plan'; doc.lastPlanning = selected; save(); throw Object.assign(Error(selected.error), { result: selected }) }
      const { target, index } = selected
      doc.lastPlanning = selected
      doc.phase = 'executing'; doc.intent = { index, target }; save()
      const result = await s.action('goto', target, 20000)
      const after = await observe()
      doc.position = after.position
      doc.diamonds = after.inventory.filter(i => i.name === 'diamond').reduce((n, i) => n + i.count, 0)
      doc.lastResult = result
      if (result.ok) doc.next = index - 1
      doc.phase = result.ok ? (doc.next < 0 ? 'mine_route_returned' : 'checkpoint') : 'needs_plan'
      save()
      console.log(JSON.stringify({ ok: result.ok, next: doc.next, position: doc.position, diamonds: doc.diamonds, reason: result.task.reason, ...(!result.ok ? { detail: result.task.lastResult } : {}) }))
      if (!result.ok) { process.exitCode = 1; break }
    }
  } finally { await s.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}
if (require.main === module) main().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message, detail: e.result })); process.exitCode = 1 })
