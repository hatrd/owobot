const { createRuntime } = require('./runtime')
const observer = require('../agent/observer')

function install (bot, { state, on, registerCleanup, log }) {
  let navigation = false
  let goal = null
  const driver = {
    busy (value) {
      if (Boolean(state.controllerBusy) === value) return
      state.controllerBusy = value
      const count = Number.isFinite(state.externalBusyCount) ? state.externalBusyCount : 0
      state.externalBusyCount = Math.max(0, count + (value ? 1 : -1))
      state.externalBusy = state.externalBusyCount > 0
      if (value) state.currentTask = { name: 'controller', source: 'controller', startedAt: Date.now() }
      else if (state.currentTask?.source === 'controller') state.currentTask = null
    },
    isBusy () {
      return Boolean((state.externalBusyCount > (state.controllerBusy ? 1 : 0) || (state.externalBusy && !state.controllerBusy)) || state.holdItemLock || state.isFishing || state.autoEat?.eating || bot.pathfinder?.goal || bot.currentWindow || bot.targetDigBlock || bot._skillRunner?.listTasks().some(t => t.status === 'running'))
    },
    stop () {
      if (navigation) {
        navigation = false
        if (bot.pathfinder?.goal === goal) {
          bot.pathfinder.setGoal(null)
          bot.clearControlStates?.()
        }
      }
      goal = null
    },
    facts: () => ({ health: bot.health, food: bot.food, oxygenLevel: bot.oxygenLevel }),
    hazard () {
      if (!state.hasSpawned || !bot.entity?.position) return 'not_spawned'
      if (bot.health <= 6) return 'low_health'
      if (Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel <= 10) return 'low_oxygen'
      if (bot.food <= 6 || state.autoEat?.eating) return 'needs_food'
      return null
    },
    async action (action, args, cancellation) {
      if (cancellation.canceled) return { ok: false, error: 'canceled' }
      if (action === 'observe') return observer.detail(bot, args)
      if (action === 'say') { bot.chat(args.text); return { ok: true } }
      if (action === 'look') { await bot.look(args.yaw, args.pitch, true); return { ok: true } }
      if (action !== 'goto') return { ok: false, error: 'unsupported_action' }
      const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
      if (!bot.pathfinder) bot.loadPlugin(pathfinder)
      const movements = new Movements(bot)
      movements.canDig = false
      movements.allow1by1towers = false
      movements.allowParkour = false
      movements.scafoldingBlocks = []
      movements.scaffoldingBlocks = []
      bot.pathfinder.setMovements(movements)
      const target = new goals.GoalNear(args.x, args.y, args.z, args.range ?? 1.5)
      goal = target
      navigation = true
      bot.pathfinder.setGoal(target)
      return new Promise(resolve => {
        const started = Date.now()
        const timer = setInterval(() => {
          if (cancellation.canceled) { clearInterval(timer); return resolve({ ok: false, error: 'canceled' }) }
          const pos = bot.entity?.position
          if (pos && target.isEnd(pos.floored())) {
            clearInterval(timer)
            driver.stop()
            return resolve({ ok: true, position: { x: pos.x, y: pos.y, z: pos.z } })
          }
          if (bot.pathfinder.goal !== target || Date.now() - started > 300000) {
            clearInterval(timer)
            driver.stop()
            resolve({ ok: false, error: 'navigation_interrupted' })
          }
        }, 100)
        timer.unref?.()
      })
    }
  }
  const runtime = createRuntime({ state, driver, log: event => log?.event?.('controller.event', event) })
  state.controllerApi = runtime
  const timer = setInterval(() => {
    try { runtime.tick() } catch (err) { log?.error?.('controller tick failed', err.message); runtime.stop() }
  }, 100)
  timer.unref?.()
  on('end', () => runtime.dispose('connection_ended'))
  on('death', () => runtime.stop())
  on('agent:stop_all', () => runtime.stop())
  for (const event of ['health', 'entityHurt', 'rain']) on(event, entity => {
    runtime.event(event, event === 'entityHurt' ? { entityId: entity?.id } : driver.facts())
  })
  let daytime = null
  on('time', () => {
    const current = bot.time?.isDay
    if (typeof current === 'boolean' && current !== daytime) { daytime = current; runtime.event(current ? 'day' : 'night', {}) }
  })
  registerCleanup(() => { clearInterval(timer); runtime.dispose(); if (state.controllerApi === runtime) state.controllerApi = null })
  return runtime
}

function read (bot, args = {}) {
  const api = bot.state?.controllerApi
  if (!api) return { ok: false, msg: 'Controller unavailable', error: 'runtime_unavailable' }
  const result = api.read(args.op || 'status', args.args || {})
  return { ...result, msg: result.ok ? 'Controller read' : result.error }
}
module.exports = { install, read }
