// Minimal high-level skill runner: startSkill/pause/cancel/status and periodic ticking

const observer = require('./observer')

function install (bot, { on, registerCleanup, log }) {
  // Reuse existing runner across reloads
  const S = bot._skillRunnerState = bot._skillRunnerState || { nextId: 1, tasks: new Map(), skills: new Map(), iv: null }
  // Hot-reload hygiene: drop previous skill registrations; tasks/controllers continue running independently
  try { if (S.skills && typeof S.skills.clear === 'function') S.skills.clear() } catch {}

  function info (...a) { try { log && log.info ? log.info('[skill]', ...a) : console.log('[skill]', ...a) } catch {} }
  function warn (...a) { try { log && log.warn ? log.warn('[skill]', ...a) : console.warn('[skill]', ...a) } catch {} }

  function registerSkill (name, factory) {
    if (!name || typeof factory !== 'function') return false
    S.skills.set(String(name), factory)
    return true
  }

  function listSkills () { return Array.from(S.skills.keys()) }

  function makeId () { return 'T' + (S.nextId++) }

  function startSkill (name, args = {}, expected = null) {
    const factory = S.skills.get(String(name))
    if (!factory) return { ok: false, msg: '未知技能', taskId: null }
    const ctl = factory({ bot, args, log, observer })
    const id = makeId()
    const task = { id, name, args, expected, status: 'running', progress: 0, createdAt: Date.now(), events: [], controller: ctl, lastTickAt: 0 }
    S.tasks.set(id, task)
    info('start', name, 'id=', id)
    // allow skill to run any immediate init
    try { if (typeof ctl.start === 'function') ctl.start() } catch (e) { warn('start err', e?.message || e) }
    return { ok: true, msg: '已开始', taskId: id }
  }

  function status (taskId) {
    const t = S.tasks.get(String(taskId))
    if (!t) return { ok: false, msg: '无此任务' }
    const { id, name, status, progress, events } = t
    return { ok: true, id, name, status, progress, events: events.slice(-10) }
  }

  function cancel (taskId) {
    const t = S.tasks.get(String(taskId))
    if (!t) return { ok: false, msg: '无此任务' }
    t.status = 'canceled'
    try { if (t.controller && typeof t.controller.cancel === 'function') t.controller.cancel() } catch {}
    S.tasks.delete(String(taskId))
    return { ok: true, msg: '已取消' }
  }

  function pause (taskId) {
    const t = S.tasks.get(String(taskId))
    if (!t) return { ok: false, msg: '无此任务' }
    t.status = 'paused'
    try { if (t.controller && typeof t.controller.pause === 'function') t.controller.pause() } catch {}
    return { ok: true, msg: '已暂停' }
  }

  function resume (taskId) {
    const t = S.tasks.get(String(taskId))
    if (!t) return { ok: false, msg: '无此任务' }
    t.status = 'running'
    try { if (t.controller && typeof t.controller.resume === 'function') t.controller.resume() } catch {}
    return { ok: true, msg: '已继续' }
  }

  function invCount (itemName) {
    try {
      const inv = bot.inventory?.items() || []
      const name = String(itemName || '').toLowerCase()
      let c = 0
      for (const it of inv) { const n = String(it?.name || '').toLowerCase(); if (n === name) c += (it.count || 0) }
      return c
    } catch { return 0 }
  }

  function checkExpected (expected) {
    try {
      if (!expected || !expected.success) return false
      const s = String(expected.success)
      // support: inventory.<item> >= N
      const m = /^\s*inventory\.([a-z0-9_]+)\s*([<>]=?)\s*(\d+)\s*$/i.exec(s)
      if (m) {
        const [, item, op, num] = m
        const cnt = invCount(item)
        const n = parseInt(num, 10)
        if (op === '>=') return cnt >= n
        if (op === '>') return cnt > n
        if (op === '==') return cnt === n
        if (op === '<=') return cnt <= n
        if (op === '<') return cnt < n
      }
      return false
    } catch { return false }
  }

  function pushEvents (task, evs) {
    if (!Array.isArray(evs) || !evs.length) return
    for (const e of evs) {
      const ev = { taskId: task.id, t: Date.now(), ...e }
      task.events.push(ev)
      try { bot.emit('skill:event', ev) } catch {}
    }
    // trim
    if (task.events.length > 100) task.events.splice(0, task.events.length - 100)
  }

  async function doTick () {
    for (const task of Array.from(S.tasks.values())) {
      if (task.status !== 'running') continue
      try {
        const ctl = task.controller
        const res = await ctl.tick?.() || { status: 'running', progress: 0 }
        if (res && res.events) pushEvents(task, res.events)
        // expected goal shortcut
        if (checkExpected(task.expected)) { task.status = 'succeeded'; task.progress = 1; S.tasks.delete(task.id); pushEvents(task, [{ type: 'expected_reached' }]); continue }
        if (res && res.status && res.status !== 'running') {
          task.status = res.status
          task.progress = Number.isFinite(res.progress) ? res.progress : (res.status === 'succeeded' ? 1 : task.progress)
          if (res.status !== 'running') { S.tasks.delete(task.id); info('end', task.name, 'id=', task.id, 'status=', res.status) }
        } else {
          task.progress = Number.isFinite(res.progress) ? res.progress : task.progress
        }
      } catch (e) {
        warn('tick error', e?.message || e)
        task.status = 'failed'
        pushEvents(task, [{ type: 'error', error: String(e?.message || e) }])
        S.tasks.delete(task.id)
        info('end', task.name, 'id=', task.id, 'status=failed')
      }
    }
  }

  function ensureTimer () {
    if (!S.iv) {
      S.iv = setInterval(() => { doTick().catch(() => {}) }, 250)
    }
  }
  ensureTimer()

  function shutdown () { try { if (S.iv) clearInterval(S.iv) } catch {}; S.iv = null; for (const [id, t] of S.tasks) { try { t.controller?.cancel?.() } catch {} ; S.tasks.delete(id) } }

  on && on('end', shutdown)
  on && on('agent:stop_all', shutdown)
  registerCleanup && registerCleanup(() => { shutdown() })

  // expose on bot for other modules
  bot._skillRunner = { registerSkill, startSkill, status, cancel, pause, resume, listSkills }
  info('runner ready')
  return bot._skillRunner
}

function ensure (bot, env) { return bot._skillRunner || install(bot, env || {}) }

module.exports = { install, ensure }
