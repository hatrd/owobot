import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import diagnostics from '../bot_impl/runtime-diagnostics.js'
import observer from '../bot_impl/agent/observer.js'

test('runtime telemetry survives reload, stays bounded, and is readable before spawn', () => {
  const bot = new EventEmitter()
  bot.state = { aiRecent: [{ text: 'private content must never enter diagnostics' }] }
  bot.entities = { a: {}, b: {} }
  bot.world = { getColumns: () => [1, 2, 3] }
  const cleanups = []
  const logged = []
  const env = { state: bot.state, registerCleanup: fn => cleanups.push(fn), log: { event: (event, data) => logged.push({ event, data }) } }
  try {
    diagnostics.install(bot, env)
    const oldStop = bot.state.runtimeDiagnostics.stop
    const first = observer.detail(bot, { what: 'runtime' })
    assert.equal(first.ok, true)
    assert.equal(logged.length, 0)
    assert.equal(first.data.samples[0].counts.entities, 2)
    assert.equal(first.data.samples[0].counts.columns, 3)
    assert.equal(first.data.samples[0].counts.aiRecent, 1)
    assert.ok(first.data.samples[0].memory.rss > 0)
    assert.doesNotMatch(JSON.stringify(first), /private content/)
    const oldSample = bot.state.runtimeDiagnostics.samples[0]
    bot.state.runtimeDiagnostics.samples = Array.from({ length: 250 }, () => oldSample)
    diagnostics.install(bot, env)
    assert.equal(bot.state.runtimeDiagnostics.samples.length, 240)
    assert.equal(bot.state.runtimeDiagnostics.reloads, 2)
    oldStop() // Stale cleanup cannot stop the replacement sampler.
    assert.equal(typeof bot.state.runtimeDiagnostics.stop, 'function')
    const snapshot = diagnostics.read(bot, { max: 2 })
    assert.equal(snapshot.data.samples.length, 2)
    snapshot.data.samples[0].memory.rss = 0
    assert.ok(bot.state.runtimeDiagnostics.samples[0].memory.rss > 0)
  } finally { cleanups.forEach(fn => fn()) }
  assert.equal(bot.state.runtimeDiagnostics.stop, null)
})
