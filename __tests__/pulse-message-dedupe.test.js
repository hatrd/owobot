import test from 'node:test'
import assert from 'node:assert/strict'
import pulseMod from '../bot_impl/ai-chat/pulse.js'
import ctxMod from '../bot_impl/ai-chat/context-bus.js'

const { createPulseService } = pulseMod
const { createContextBus } = ctxMod

function makeNow () {
  let t = Date.now()
  const fn = () => t
  fn.advance = (ms) => { t += ms; return t }
  fn.step = (ms) => { t += ms; return t }
  return fn
}

function makePulse () {
  const now = makeNow()
  const state = {
    ai: { enabled: true, key: 'test' },
    aiPulse: { enabled: true },
    aiExtras: { events: [] },
    aiRecent: [],
    aiRecentSeq: 0
  }
  const bot = { username: 'bot', chat: () => {} }
  const contextBus = createContextBus({ state, now })
  const pulse = createPulseService({
    state,
    bot,
    log: null,
    now,
    H: {},
    defaults: {},
    canAfford: () => ({ ok: true }),
    applyUsage: () => {},
    buildContextPrompt: () => '',
    buildGameContext: () => '',
    traceChat: () => {},
    memory: { dialogue: { maybeRunAggregation: () => {}, queueSummary: () => {} }, longTerm: { persistState: () => {} } },
    feedbackCollector: null,
    contextBus
  })
  return { state, contextBus, pulse }
}

test('dedupe: <player> msg from system message does not duplicate chat capture', () => {
  const { contextBus, pulse } = makePulse()
  pulse.captureChat('kuleizi', '不是我干的')
  pulse.captureSystemMessage({ getText: () => '<kuleizi> 不是我干的' })
  const store = contextBus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].type, 'player')
  assert.deepEqual(store[0].payload, { name: 'kuleizi', content: '不是我干的' })
})

test('dedupe: duplicate chat events do not create two <p> entries', () => {
  const { contextBus, pulse } = makePulse()
  pulse.captureChat('li_log2', '我觉得是mineflayer/mindcraft的不稳定性')
  pulse.captureChat('li_log2', '我觉得是mineflayer/mindcraft的不稳定性')
  const store = contextBus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].type, 'player')
  assert.deepEqual(store[0].payload, { name: 'li_log2', content: '我觉得是mineflayer/mindcraft的不稳定性' })
})

test('system message <player> msg is treated as player chat when chat event is missing', () => {
  const { state, contextBus, pulse } = makePulse()
  pulse.captureSystemMessage({ toString: () => '<kuleizi> owkowk 在哪' })
  const store = contextBus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].type, 'player')
  assert.deepEqual(store[0].payload, { name: 'kuleizi', content: 'owkowk 在哪' })
  assert.equal(state.aiRecent.length, 1)
  assert.equal(state.aiRecent[0].kind, 'player')
  assert.equal(state.aiPulse.pendingByUser.get('kuleizi').count, 1)
})

test('non chat system messages still go to server context', () => {
  const { state, contextBus, pulse } = makePulse()
  pulse.captureSystemMessage({ getText: () => '登录成功！' })
  const store = contextBus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].type, 'server')
  assert.deepEqual(store[0].payload, { content: '登录成功！' })
  assert.equal(state.aiRecent.length, 0)
})

test('deathchest system message is emitted as event only (no duplicate server line)', () => {
  const { contextBus, pulse } = makePulse()
  pulse.captureSystemMessage({ getText: () => '[DeathChest] Your DeathChest will disappear in 180 seconds!' })
  const store = contextBus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].type, 'event')
  assert.deepEqual(store[0].payload, { eventType: 'death_info', data: '[DeathChest] Your DeathChest will disappear in 180 seconds!' })
})

test('deathchest chat + system notices emit a single event', () => {
  const { state, contextBus, pulse } = makePulse()
  const chatText = 'Your DeathChest is located at X: 2482, Y: 63, Z: 2504, World: world'
  const systemText = '[DeathChest] Your DeathChest is located at X: 2482, Y: 63, Z: 2504, World: world'
  pulse.captureChat('DeathChest', chatText)
  pulse.captureSystemMessage({ getText: () => systemText })
  const store = contextBus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].type, 'event')
  assert.deepEqual(store[0].payload, { eventType: 'death_info', data: systemText })
  assert.equal(state.aiRecent.length, 0)
})
