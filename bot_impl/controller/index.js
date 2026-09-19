const { createRuntime } = require('./runtime')
const observer = require('../agent/observer')
const { createNavigator } = require('../navigation/drive')
const { body } = require('../navigation/liquids')
const { oxygen } = require('../navigation/oxygen')

function install (bot, { state, on, registerCleanup, log }) {
  const navigator = createNavigator(bot, state)
  const driver = {
    beforeAcquire (args) { if (args.controllerId !== require('../life/runtime').OWNER) state.lifeApi?.yield('external_controller') },
    knowledgeRead: args => state.knowledgeApi?.query(args),
    knowledgeWrite: (op, args) => state.knowledgeApi?.write(op, args),
    memoryRead: args => state.explorationApi?.recall(args),
    memoryWrite: (op, args) => state.explorationApi?.write(op, args),
    canStartMission: (id, behavior) => state.explorationApi?.canStart(id, behavior),
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
    stop () { navigator.stop(); if (bot.targetDigBlock) bot.stopDigging(); if (state.storageTransfer?.phase === 'opening' || state.storageTransfer?.phase === 'transferring') { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } },
    facts: () => ({ health: bot.health, food: bot.food, oxygenLevel: oxygen(bot).level }),
    hazard () {
      if (!state.hasSpawned || !bot.entity?.position) return 'not_spawned'
      if (state.autoSwim?.runtime?.active) return 'water_recovery'
      if (typeof bot.blockAt === 'function' && body(bot).head === 'water') return 'water_recovery'
      if (bot.health <= 6) return 'low_health'
      if (oxygen(bot).level !== null && oxygen(bot).level <= 10) return 'low_oxygen'
      if (bot.food <= 6 || state.autoEat?.eating) return 'needs_food'
      return null
    },
    async action (action, args, cancellation) {
      if (cancellation.canceled) return { ok: false, error: 'canceled' }
      if (action === 'storage_transfer') return require('./storage').transfer(bot, state, args, cancellation)
      if (action === 'excavate') return require('./excavate').excavate(bot, state, args, cancellation)
      if (action === 'discard') return require('./excavate').discard(bot, args, cancellation)
      if (action === 'feed_cat') return require('./feed-cat').feedCat(bot, state, args, cancellation)
      if (action === 'observe') return observer.detail(bot, args)
      if (action === 'say') { bot.chat(args.text); return { ok: true } }
      if (action === 'look') { await bot.look(args.yaw, args.pitch, true); return { ok: true } }
      if (action !== 'goto') return { ok: false, error: 'unsupported_action' }
      return navigator.start(args, cancellation, pos => {
        const task = state.controller?.tasks.find(t => t.id === cancellation.taskId)
        const mission = state.explorationMemory?.document.missions.find(m => m.id === task?.missionId)
        if (state.life?.runtime?.session?.taskId === cancellation.taskId && !state.lifeApi?.boundary(pos)) return false
        return !mission || Math.hypot(pos.x - mission.home.x, pos.y - mission.home.y, pos.z - mission.home.z) <= mission.maxRadius
      })
    }
  }
  const runtime = createRuntime({ state, driver, log: event => { log?.event?.('controller.event', event); state.explorationApi?.record(event) } })
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
