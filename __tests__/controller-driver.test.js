const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { install } = require('../bot_impl/controller')
const { call } = require('../scripts/controller-client')
const net = require('net')
const path = require('path')
const os = require('os')
const fs = require('fs')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test('actual goto driver waits for arrival, stops on cancel, and cleanup revokes control', async () => {
  const bot = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.4')
  bot.state = { hasSpawned: true }
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.health = 20; bot.food = 20; bot.oxygenLevel = 20
  bot.clearControlStates = () => {}
  bot.pathfinder = { goal: null, setGoal (g) { this.goal = g }, setMovements (m) { assert.equal(m.canDig, false); assert.equal(m.allow1by1towers, false) } }
  const cleanups = []
  const api = install(bot, { state: bot.state, on: bot.on.bind(bot), registerCleanup: fn => cleanups.push(fn) })
  try {
    const lease = api.write('session.acquire', { controllerId: 'driver-test', ttlMs: 10000 })
    assert.equal(lease.ok, true)
    const auth = { leaseId: lease.leaseId, epoch: lease.epoch }
    const behavior = { id: 'move', revision: '1', entry: 'walk', nodes: { walk: { type: 'action', action: 'goto', args: { x: 10, y: 64, z: 0, range: 1 }, next: 'end', timeoutMs: 3000 }, end: { type: 'end' } } }
    assert.equal(api.write('behavior.install', { ...auth, behavior }).ok, true)
    const start = requestId => api.write('task.start', { ...auth, behaviorId: 'move', revision: '1', requestId, timeoutMs: 5000 })
    const first = start('a')
    api.tick(); await pause(130)
    assert.ok(bot.pathfinder.goal)
    assert.equal(api.read('status', { taskId: first.taskId }).tasks[0].status, 'running')
    bot.entity.position = new Vec3(10, 64, 0)
    await pause(250)
    assert.equal(api.read('status', { taskId: first.taskId }).tasks[0].status, 'succeeded')
    bot.entity.position = new Vec3(0, 64, 0)
    const second = start('b'); api.tick(); await pause(120)
    assert.ok(bot.pathfinder.goal)
    api.write('task.cancel', { ...auth, taskId: second.taskId })
    assert.equal(bot.pathfinder.goal, null)
    await pause(120)
    assert.equal(api.read('status', { taskId: second.taskId }).tasks[0].status, 'canceled')
  } finally { bot.removeAllListeners(); cleanups.forEach(fn => fn()) }
  assert.equal(bot.state.controller.lease, null)
  assert.equal(bot.state.controllerApi, null)
  assert.equal(bot.state.externalBusy, false)
  assert.equal(bot.state.externalBusyCount, 0)
})

test('SDK routes reads and dry writes without invoking tool.run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-sdk-'))
  const sock = path.join(dir, 'test.sock')
  const seen = []
  const server = net.createServer(socket => {
    let buffer = ''
    socket.on('data', data => {
      buffer += data
      if (!buffer.includes('\n')) return
      const payload = JSON.parse(buffer.trim()); seen.push(payload)
      socket.end(JSON.stringify({ id: payload.id, ok: true, result: { ok: true } }) + '\n')
    })
  })
  await new Promise(resolve => server.listen(sock, resolve))
  try {
    await call('status', {}, { sock })
    await call('observe', { what: 'view' }, { sock })
    await call('session.acquire', { controllerId: 'test', ttlMs: 1000 }, { sock, dry: true })
    assert.deepEqual(seen.map(x => x.op), ['tool.dry', 'tool.dry', 'tool.dry'])
    assert.deepEqual(seen.map(x => x.tool), ['controller_read', 'observe_detail', 'controller_write'])
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }) }
})
