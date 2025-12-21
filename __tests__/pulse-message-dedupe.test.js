import test from 'node:test'
import assert from 'node:assert/strict'
import pulseMod from '../bot_impl/ai-chat/pulse.js'
import ctxMod from '../bot_impl/ai-chat/context-bus.js'

const { createPulseService } = pulseMod
const { createContextBus } = ctxMod

function makeNow () {
  let t = Date.now()
  return () => { t += 5; return t }
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

