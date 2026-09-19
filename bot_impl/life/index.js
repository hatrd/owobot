const path = require('path')
const { createStore } = require('./store')
const { createRuntime } = require('./runtime')
const { survey, distance } = require('../exploration/terrain')
const { oxygen } = require('../navigation/oxygen')
const observer = require('../agent/observer')
function install (bot, { state, on, registerCleanup, log }) {
  const worldId = state.explorationMemory?.worldId
  if (!worldId) throw new Error('life_requires_world_identity')
  const store = createStore({ state, worldId, file: path.resolve('data', `life-${worldId}.json`) })
  const driver = {
    controller: () => state.controllerApi,
    candidates: () => state.hasSpawned ? (survey(bot, { radius: 10, max: 40 }).data?.candidates || []) : [],
    facts () {
      const p = state.hasSpawned && bot.entity?.position
      const position = p ? { x: p.x, y: p.y, z: p.z } : null
      const cats = Object.values(bot.entities || {}).filter(e => e.name === 'cat' && e.uuid && e.position && p && distance(p, e.position) <= 16)
        .map(e => ({ uuid: e.uuid, position: { x: e.position.x, y: e.position.y, z: e.position.z } })).sort((a, b) => distance(a.position, p) - distance(b.position, p))
      const owns = state.life?.runtime?.session && state.controller?.lease?.id === state.life.runtime.session.auth.leaseId
      const busy = Boolean((state.controller?.lease && !owns) || state.externalBusyCount > (owns && state.controllerBusy ? 1 : 0) ||
        (state.externalBusy && !owns) || state.isFishing || (state.holdItemLock && !(owns && state.lifeFeeding)) || bot.currentWindow || bot.targetDigBlock ||
        (bot.pathfinder?.goal && !owns) || bot._skillRunner?.listTasks().some(t => t.status === 'running'))
      const air = oxygen(bot).level
      return { position, dimension: String(bot.game?.dimension || 'unknown'), health: bot.health, food: bot.food,
        timeOfDay: bot.time?.timeOfDay, thunder: Boolean(bot.thunderState > 0),
        recovering: Boolean(state.autoSwim?.runtime?.active || state.autoEat?.eating || (air !== null && air <= 10)),
        busy, cats, fish: (bot.inventory?.items() || []).some(i => ['cod', 'salmon'].includes(i.name) && i.count > 0),
        hostiles: position ? observer.snapshot(bot, { hostileRange: 24 }).nearby.hostiles.count : 0, candidates: [] }
    }
  }
  const api = createRuntime({ state, store, driver, log: event => log?.event?.('life.transition', event) })
  state.lifeApi = api
  const timer = setInterval(() => { try { api.tick() } catch (error) { log?.error?.('life tick failed', error.message); api.stop('runtime_error') } }, 1000)
  timer.unref?.()
  on('spawn', () => api.connection(true))
  on('end', () => api.connection(false))
  on('death', () => api.stop('death'))
  on('agent:stop_all', () => api.stop('emergency_stop'))
  registerCleanup(() => { clearInterval(timer); api.dispose(); if (state.lifeApi === api) state.lifeApi = null })
  return api
}
function read (bot) {
  const result = bot.state?.lifeApi?.status() || { ok: false, error: 'life_unavailable' }
  return { ...result, msg: result.ok ? 'Autonomous life status and read-only decision preview' : result.error }
}
module.exports = { install, read }
