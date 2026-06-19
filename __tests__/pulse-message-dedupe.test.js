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

function makePulse (overrides = {}) {
  const now = makeNow()
  const state = {
    ai: { enabled: true, key: 'test' },
    aiPulse: {},
    aiRecent: [],
    aiRecentSeq: 0
  }
  const bot = { username: 'bot', chat: () => {}, ...(overrides.bot || {}) }
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

function makePulseWithOverflowFetch () {
  const now = makeNow()
  const calls = []
  const state = {
    ai: {
      enabled: true,
      key: 'test',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      context: { recentStoreMax: 20 },
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiPulse: {},
    aiRecent: [],
    aiRecentSeq: 0,
    aiCallMonitor: {}
  }
  const bot = { username: 'bot', chat: () => {} }
  const contextBus = createContextBus({ state, now })
  const oldFetch = global.fetch
  global.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    calls.push(body)
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '玩家们讨论了挖矿和补给。' } }]
      })
    }
  }
  const H = {
    buildAiUrl: ({ baseUrl, path }) => `${baseUrl}${path}`,
    isResponsesApiPath: () => false,
    extractAssistantTextFromApiResponse: (data) => String(data?.choices?.[0]?.message?.content || ''),
    extractAssistantText: (msg) => String(msg?.content || '')
  }
  const pulse = createPulseService({
    state,
    bot,
    log: null,
    now,
    H,
    defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
    canAfford: () => ({ ok: true }),
    applyUsage: () => {},
    traceChat: () => {},
    memory: { dialogue: { maybeRunAggregation: () => {}, queueSummary: () => {} }, longTerm: { persistState: () => {} } },
    feedbackCollector: null,
    contextBus
  })
  return { state, contextBus, pulse, calls, now, restore: () => { global.fetch = oldFetch } }
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

test('say: injects planned bot lines into context bus immediately', () => {
  const { contextBus, pulse } = makePulse()
  const ok = pulse.say('kuleizi', { steps: ['第一句', '第二句'], gapMs: 0, typing: { enabled: false } }, { from: 'LLM' })
  assert.equal(ok, true)
  const store = contextBus.getStore()
  assert.equal(store.length, 2)
  assert.equal(store[0].type, 'bot')
  assert.deepEqual(store[0].payload, { content: '第一句', from: 'LLM' })
  assert.equal(store[1].type, 'bot')
  assert.deepEqual(store[1].payload, { content: '第二句', from: 'LLM' })
})

test('say: pure pauseMs step delays the next message without requiring kind', async () => {
  const sent = []
  const { pulse } = makePulse({ bot: { username: 'bot', chat: (text) => sent.push({ text, t: Date.now() }) } })
  const ok = pulse.say('kuleizi', { steps: ['第一句', { pauseMs: 30 }, '第二句'], gapMs: 0, typing: { enabled: false } }, { from: 'LLM' })
  assert.equal(ok, true)
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(sent.length, 2)
  assert.equal(sent[0].text, '第一句')
  assert.equal(sent[1].text, '第二句')
  assert.ok(sent[1].t - sent[0].t >= 25, `expected pause before second message, got ${sent[1].t - sent[0].t}ms`)
})

test('overflow summary sends compact input and small output budget', async () => {
  const { state, pulse, calls, restore } = makePulseWithOverflowFetch()
  try {
    const long = '很长的聊天内容'.repeat(80)
    state.aiRecent = Array.from({ length: 70 }, (_, i) => ({
      t: Date.now() - (70 - i) * 1000,
      user: `old${i % 4}`,
      text: `${i} ${long}`,
      kind: 'player',
      seq: i + 1
    }))
    state.aiRecentSeq = 70
    pulse.captureChat('player0', `new ${long}`)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(calls.length >= 1)
    const body = calls[0]
    assert.ok(Number(body.max_tokens) <= 96, `expected overflow max_tokens <= 96, got ${body.max_tokens}`)
    const userPrompt = String(body.messages?.find(m => m.role === 'user')?.content || '')
    assert.ok(userPrompt.length <= 2400, `expected compact overflow prompt <= 2400 chars, got ${userPrompt.length}`)
    assert.ok(state.aiRecent.length <= 20)
  } finally {
    restore()
  }
})
