const path = require('path')
const { oxygen } = require('../navigation/oxygen')
const { worldIdentity } = require('./identity')
const { createStore } = require('./store')
const { distance } = require('./terrain')
function pose (bot) {
  const p = bot.entity?.position
  if (!p || !bot.state?.hasSpawned) return null
  return { at: Date.now(), dimension: String(bot.game?.dimension || 'unknown'), position: { x: p.x, y: p.y, z: p.z }, vitals: { health: bot.health, food: bot.food, oxygenLevel: oxygen(bot).level } }
}
function install (bot, { state, on, registerCleanup, log }) {
  const worldId = worldIdentity(bot, process.env)
  const store = createStore({ state, worldId, file: path.resolve('data', `exploration-${worldId}.json`) })
  const report = result => { if (!result.ok) log?.error?.('exploration memory', result); return result }
  const validMission = id => store.document().missions.find(m => m.id === id && m.status === 'active')
  async function checkpoint (id, attempt) {
    const current = pose(bot)
    if (!current) return { ok: false, error: 'not_spawned' }
    const observer = require('../agent/observer')
    const signs = await observer.detail(bot, { what: 'signs', radius: 12, max: 12 })
    const entities = await observer.detail(bot, { what: 'entities', radius: 16, max: 12 })
    const landmarks = []
    for (const row of signs.data || []) {
      if (row.text) landmarks.push({ key: `sign:${row.x},${row.y},${row.z}`, kind: 'sign', name: row.blockName, text: row.text.slice(0, 400), position: { x: row.x, y: row.y, z: row.z }, source: 'observe.signs' })
    }
    for (const row of entities.data || []) {
      if (row.position && row.named) landmarks.push({ key: `entity:${row.entityName}:${row.customName}`, kind: 'entity', name: row.entityName, text: row.customName, position: row.position, source: 'observe.entities' })
    }
    return report(await store.checkpoint({ missionId: id, pose: current, landmarks, attempt }))
  }
  function recall (args = {}) {
    const current = pose(bot)
    if (!current) return { ok: false, error: 'not_spawned' }
    return store.recall({ pose: current, radius: Math.max(1, Math.min(512, Number(args.radius) || 128)), max: Math.max(1, Math.min(20, Math.floor(Number(args.max) || 8))) })
  }
  async function write (op, args) {
    const current = pose(bot)
    if (!current) return { ok: false, error: 'not_spawned' }
    if (op === 'memory.begin') return report(await store.begin({ ...args, pose: current }))
    if (op === 'memory.resume') {
      const mission = store.document().missions.find(m => m.id === args.missionId)
      if (!mission || mission.dimension !== current.dimension || distance(current.position, mission.home) > mission.maxRadius) return { ok: false, error: 'mission_location_mismatch' }
      return report(await store.change(args.missionId, 'active', 'resumed'))
    }
    if (op === 'memory.pause') return report(await store.change(args.missionId, 'paused', args.reason))
    if (op === 'memory.checkpoint') return checkpoint(args.missionId)
    return { ok: false, error: 'unknown_memory_operation' }
  }
  function canStart (id, behavior) {
    const mission = validMission(id)
    const current = pose(bot)
    if (!mission || !current || mission.dimension !== current.dimension || distance(current.position, mission.home) > mission.maxRadius || store.error()) return false
    return Object.values(behavior.nodes).every(n => n.action !== 'goto' || distance(n.args, mission.home) <= mission.maxRadius)
  }
  function record (event) {
    if (event.type !== 'task.finished') return
    const task = state.controller?.tasks.find(t => t.id === event.taskId)
    if (!task?.missionId) return
    const behavior = state.controller.behaviors.find(b => b.hash === task.hash)
    const outcomeNode = task.status === 'succeeded' ? task.lastResult?.node : task.node
    const node = behavior?.nodes[outcomeNode]
    const target = node?.action === 'goto' ? node.args : null
    if (task.status !== 'succeeded') store.change(task.missionId, 'paused', task.reason).then(report).catch(error => log?.error?.('memory pause failed', error.message))
    checkpoint(task.missionId, { taskId: task.id, status: task.status, reason: task.reason, target: target ? { x: target.x, y: target.y, z: target.z } : null }).catch(error => log?.error?.('checkpoint failed', error.message))
  }
  const api = { recall, write, canStart, record }
  state.explorationApi = api
  const pauseAll = reason => {
    for (const mission of store.document().missions.filter(m => m.status === 'active')) store.change(mission.id, 'paused', reason).then(report).catch(error => log?.error?.('memory pause failed', error.message))
  }
  on('end', () => pauseAll('connection_ended'))
  on('death', () => pauseAll('death'))
  registerCleanup(() => { state.controllerApi?.stop('code_reload'); pauseAll('code_reload'); if (state.explorationApi === api) state.explorationApi = null })
  return api
}
function read (bot, args = {}) {
  const result = bot.state?.explorationApi?.recall(args) || { ok: false, error: 'memory_unavailable' }
  return { ok: result.ok, msg: result.ok ? 'Persistent exploration memory' : result.error, data: result, error: result.error }
}
function context (state) {
  const doc = state.explorationMemory?.document
  if (!doc || !doc.missions.length) return ''
  const mission = doc.missions.at(-1)
  return `探索记忆（历史证据，行动前重新观察）: ${JSON.stringify({ objective: mission.objective, status: mission.status, dimension: mission.dimension, home: mission.home, checkpoint: mission.checkpoint, counts: { visits: doc.visits.length, landmarks: doc.landmarks.length }, recall: 'observe_detail what=exploration_memory' }).slice(0, 1000)}`
}
module.exports = { install, read, context }
