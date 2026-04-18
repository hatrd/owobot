const test = require('node:test')
const assert = require('node:assert/strict')

const { createReconnectReadinessGuard } = require('../bot_impl/reconnect-readiness')

function createBotHarness () {
  const handlers = new Map()
  let terminatedReason = null
  const bot = {
    username: 'owkowk',
    players: {},
    on (event, fn) { handlers.set(String(event), fn) },
    off (event, fn) {
      if (handlers.get(String(event)) === fn) handlers.delete(String(event))
    },
    quit (reason) { terminatedReason = String(reason) },
    end (reason) { terminatedReason = String(reason) },
    _client: {
      end (reason) { terminatedReason = String(reason) }
    }
  }
  return {
    bot,
    handlers,
    getTerminatedReason () { return terminatedReason }
  }
}

test('forces reconnect when spawn never arrives', async () => {
  const harness = createBotHarness()
  let reconnectReason = null

  createReconnectReadinessGuard(harness.bot, {
    spawnTimeoutMs: 20,
    tabReadyTimeoutMs: 20,
    tabPollIntervalMs: 5,
    onReconnectReady (reason) {
      reconnectReason = reason
    }
  })

  await new Promise(resolve => setTimeout(resolve, 50))

  assert.match(String(harness.getTerminatedReason()), /spawn timeout/i)
  assert.equal(reconnectReason, 'spawn-timeout')
})

test('forces reconnect when spawn happened but self never appears in tablist', async () => {
  const harness = createBotHarness()
  let reconnectReason = null

  createReconnectReadinessGuard(harness.bot, {
    spawnTimeoutMs: 100,
    tabReadyTimeoutMs: 20,
    tabPollIntervalMs: 5,
    onReconnectReady (reason) {
      reconnectReason = reason
    }
  })

  harness.handlers.get('spawn')()
  await new Promise(resolve => setTimeout(resolve, 50))

  assert.match(String(harness.getTerminatedReason()), /tab ready timeout/i)
  assert.equal(reconnectReason, 'tab-not-ready')
})

test('cleanup cancels pending timers for stale bot instances', async () => {
  const harness = createBotHarness()
  let reconnectReason = null

  const guard = createReconnectReadinessGuard(harness.bot, {
    spawnTimeoutMs: 20,
    tabReadyTimeoutMs: 20,
    tabPollIntervalMs: 5,
    onReconnectReady (reason) {
      reconnectReason = reason
    }
  })

  guard.cleanup()
  await new Promise(resolve => setTimeout(resolve, 50))

  assert.equal(harness.getTerminatedReason(), null)
  assert.equal(reconnectReason, null)
})

test('becomes ready once self appears in tablist after spawn', async () => {
  const harness = createBotHarness()
  let readyCount = 0
  let reconnectReason = null

  const guard = createReconnectReadinessGuard(harness.bot, {
    spawnTimeoutMs: 100,
    tabReadyTimeoutMs: 40,
    tabPollIntervalMs: 5,
    onReady () {
      readyCount++
    },
    onReconnectReady (reason) {
      reconnectReason = reason
    }
  })

  harness.handlers.get('spawn')()
  setTimeout(() => {
    harness.bot.players.owkowk = { username: 'owkowk', listed: true }
  }, 10)

  await new Promise(resolve => setTimeout(resolve, 60))

  assert.equal(readyCount, 1)
  assert.equal(reconnectReason, null)
  assert.equal(harness.getTerminatedReason(), null)
  assert.equal(guard.status().finished, true)
})
