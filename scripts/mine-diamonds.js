#!/usr/bin/env node
// One goal command: local ore planning, inventory maintenance, retracing, and a recorded home route.
const fs = require('fs')
const path = require('path')
const { runNode } = require('./lib/run-node')
const { randomUUID } = require('crypto')
const { call } = require('./controller-client')
const { session, checked, makeBehavior, wait } = require('./cerebellum')
async function main () {
  const flags = Object.fromEntries(process.argv.slice(2).map(v => v.replace(/^--/, '').split('=')))
  const target = Number(flags.target || 64)
  if (!Number.isInteger(target) || target < 1 || target > 2304) throw Error('invalid_target')
  const homes = checked(await call('knowledge.query', flags.home ? { id: flags.home } : { kind: 'home', max: 2 }))
  if (homes.records.length !== 1) throw Error('one_explicit_home_required')
  const home = homes.records[0], world = homes.worldId
  const file = path.resolve('data', `diamond-goal-${world}.json`)
  if (Object.hasOwn(flags, 'status')) {
    const observation = checked(await call('observe', { what: 'excavation', radius: 4, max: 1 })).data
    console.log(JSON.stringify({ ok: true, goal: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null, current: { position: observation.position, vitals: observation.vitals, diamonds: observation.inventory.filter(i => i.name === 'diamond').reduce((n, i) => n + i.count, 0) } }))
    return
  }
  if (!flags['return-route']) throw Error('recorded_return_route_required')
  const routeRecord = checked(await call('knowledge.query', { id: flags['return-route'] })).records[0]
  if (!routeRecord || routeRecord.dimension !== home.dimension || routeRecord.confidence !== 'observed') throw Error('observed_home_route_required')
  const homeRoute = JSON.parse(routeRecord.fact).actions
  if (!Array.isArray(homeRoute) || !homeRoute.length || homeRoute.length > 80) throw Error('invalid_home_route')
  for (const a of homeRoute) {
    if (!['goto', 'surface_travel'].includes(a.action)) throw Error('travel_only_return_route_required')
    checked(await call('behavior.validate', { behavior: makeBehavior(a.action, a.args, 60000) }))
  }
  const observe = async () => checked(await call('observe', { what: 'excavation', radius: 4, max: 1 })).data
  const count = d => d.inventory.filter(i => i.name === 'diamond').reduce((n, i) => n + i.count, 0)
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, world, target, homeId: home.id, returnRouteId: routeRecord.id, phase: 'mining', homeIndex: 0, actions: 0 }
  if (doc.world !== world || doc.target !== target || doc.homeId !== home.id || doc.returnRouteId !== routeRecord.id) throw Error('goal_configuration_mismatch')
  const save = () => { doc.updatedAt = Date.now(); const tmp = `${file}.${randomUUID()}.tmp`; const fd = fs.openSync(tmp, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(doc)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) } fs.renameSync(tmp, file) }
  let canceled = false, activeSession = null
  const abort = new AbortController()
  const stop = () => { canceled = true; abort.abort(); activeSession?.close().catch(() => {}) }
  const run = (script, args) => runNode(path.join(__dirname, script), args, abort.signal)
  if (Object.hasOwn(flags, 'dry')) {
    const d = await observe()
    console.log(JSON.stringify({ ok: true, dry: true, target, diamonds: count(d), home: home.position, returnActions: homeRoute.length, plan: await call('mining.plan', { radius: 32 }) }))
    return
  }
  if (doc.phase === 'complete') {
    const d = await observe(), p = d.position, h = home.position
    const verifiedNow = count(d) >= target && d.vitals.health > 0 && d.dimension === home.dimension && Math.hypot(p.x - h.x - 0.5, p.z - h.z - 0.5) <= 2 && Math.abs(p.y - h.y) <= 1
    console.log(JSON.stringify({ ok: verifiedNow, phase: doc.phase, verifiedNow, diamonds: count(d), position: p }))
    if (!verifiedNow) process.exitCode = 1
    return
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    if (doc.error) doc.lastFailure = doc.error
    delete doc.error; doc.status = 'running'; save()
    let unchanged = 0, previous = null
    while (doc.phase === 'mining') {
      if (canceled) throw Error('canceled')
      const d = await observe(); doc.diamonds = count(d); doc.position = d.position; save()
      if (d.dimension !== home.dimension) throw Error('wrong_dimension')
      if (doc.diamonds >= target) { doc.phase = 'return_mine'; save(); break }
      if (d.vitals.health < 16 || d.vitals.food < 10) throw Error('unsafe_vitals')
      let plan = await call('mining.plan', { radius: 32, maxNodes: 6000 })
      if (!plan.ok) plan = await call('mining.plan', { radius: 64, maxNodes: 10000 })
      if (!plan.ok) throw Object.assign(Error(plan.error), { detail: plan })
      const p = plan.next.args, from = { x: Math.floor(d.position.x), y: Math.floor(d.position.y), z: Math.floor(d.position.z) }
      const dx = p.x - from.x, dz = p.z - from.z
      const direction = dx === 1 ? 'east' : dx === -1 ? 'west' : dz === 1 ? 'south' : dz === -1 ? 'north' : null
      if (!direction || Math.abs(dx) + Math.abs(dz) !== 1) throw Error('invalid_planned_step')
      const signature = JSON.stringify([from, p, doc.diamonds])
      unchanged = signature === previous ? unchanged + 1 : 0; previous = signature
      if (unchanged >= 2) throw Error('no_progress')
      doc.intent = plan.next; doc.targetOre = plan.targetOre; save()
      await run('diamond-expedition.js', [`--direction=${direction}`, '--steps=1', `--floor=${p.y}`, '--dry'])
      await run('diamond-expedition.js', [`--direction=${direction}`, '--steps=1', `--floor=${p.y}`])
      await wait(500)
      doc.actions++; const after = await observe(); doc.diamonds = count(after); doc.position = after.position; save()
      console.log(JSON.stringify({ phase: doc.phase, actions: doc.actions, diamonds: doc.diamonds, target, position: doc.position, ore: plan.targetOre }))
    }
    while (doc.phase === 'return_mine') {
      await run('expedition-return.js', ['--steps=80', '--dry'])
      await run('expedition-return.js', ['--steps=80'])
      const back = JSON.parse(fs.readFileSync(path.resolve('data', `diamond-return-${world}.json`), 'utf8'))
      console.log(JSON.stringify({ phase: doc.phase, next: back.next, diamonds: back.diamonds, position: back.position }))
      if (back.next < 0) { doc.phase = 'return_home'; save() }
    }
    if (doc.phase === 'return_home') {
      const s = activeSession = await session('diamond-goal-home')
      try {
        for (; doc.homeIndex < homeRoute.length; doc.homeIndex++) {
          if (canceled) throw Error('canceled')
          const a = homeRoute[doc.homeIndex]; doc.intent = a; save()
          const result = await s.action(a.action, a.args, 60000)
          doc.lastResult = result; save()
          if (!result.ok) throw Object.assign(Error('home_route_failed'), { detail: result })
          console.log(JSON.stringify({ phase: doc.phase, homeIndex: doc.homeIndex, action: a.action }))
        }
      } finally { await s.close(); activeSession = null }
      const d = await observe(), p = d.position, h = home.position
      if (count(d) < target || d.vitals.health <= 0 || d.dimension !== home.dimension || Math.hypot(p.x - h.x - 0.5, p.z - h.z - 0.5) > 2 || Math.abs(p.y - h.y) > 1) throw Error('completion_not_verified')
      doc.phase = 'complete'; doc.status = 'succeeded'; doc.diamonds = count(d); doc.position = p; doc.vitals = d.vitals; save()
      console.log(JSON.stringify(doc))
    }
  } catch (e) { doc.status = e.message === 'canceled' ? 'canceled' : 'needs_attention'; doc.error = { message: e.message, detail: e.detail }; save(); throw e }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}
if (require.main === module) main().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message, detail: e.detail })); process.exitCode = 1 })
