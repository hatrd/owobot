import test from 'node:test'
import assert from 'node:assert/strict'
import { createAiCallMonitor, buildDefaultExternalCallPolicy } from '../bot_impl/ai-chat/call-monitor.js'
import { prepareAiState } from '../bot_impl/ai-chat/state-init.js'
import { prepareSharedState } from '../bot_impl/state.js'
import { createChatExecutor } from '../bot_impl/ai-chat/executor.js'
import H from '../bot_impl/ai-chat-helpers.js'

const defaults = {
  DEFAULT_MODEL: 'deepseek-chat',
  DEFAULT_BASE: 'https://example.invalid',
  DEFAULT_PATH: '/v1/chat/completions',
  DEFAULT_TIMEOUT_MS: 1000,
  DEFAULT_RECENT_COUNT: 12,
  DEFAULT_RECENT_WINDOW_SEC: 300,
  DEFAULT_MEMORY_STORE_MAX: 20,
  buildDefaultContext: () => ({ include: true, game: {}, memory: {} })
}

test('shared state keeps auto-look disabled by default', () => {
  const state = prepareSharedState({}, {})
  assert.equal(state.autoLookEnabled, false)
  assert.equal(state.autoLookSuspended, false)
})

test('AI state defaults to main chat as the only external chat call source', () => {
  const state = {}
  prepareAiState(state, {
    defaults,
    persistedMemory: { dialogues: [], long: [], memories: [] },
    persistedEvolution: {},
    dayStart: () => 0,
    monthStart: () => 0
  })
  assert.deepEqual(state.ai.externalCalls, buildDefaultExternalCallPolicy())
  assert.equal(state.ai.externalCalls.allowBackground, false)
  assert.deepEqual(state.ai.externalCalls.allowSources, ['main_chat'])
})

test('AI call monitor blocks background calls by default and records them', async () => {
  const state = { ai: { externalCalls: buildDefaultExternalCallPolicy() } }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  let called = false
  await assert.rejects(
    monitor.request({
      source: 'memory_rewrite',
      kind: 'chat',
      model: 'deepseek-chat',
      url: 'https://example.invalid/v1/chat/completions',
      body: { model: 'deepseek-chat', messages: [] },
      fetchImpl: async () => { called = true }
    }),
    /ai_call_blocked:memory_rewrite/
  )
  assert.equal(called, false)
  assert.equal(state.aiCallMonitor.counts.blocked, 1)
  assert.equal(state.aiCallMonitor.recent.at(-1).status, 'blocked')
})

test('AI call monitor allows and records main chat calls', async () => {
  const state = { ai: { externalCalls: buildDefaultExternalCallPolicy() } }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const res = await monitor.request({
    source: 'main_chat',
    kind: 'chat',
    model: 'deepseek-chat',
    url: 'https://example.invalid/v1/chat/completions',
    body: { model: 'deepseek-chat', messages: [] },
    headers: { 'Content-Type': 'application/json' },
    fetchImpl: async () => ({ ok: true, status: 200 })
  })
  assert.equal(res.ok, true)
  assert.equal(state.aiCallMonitor.counts.started, 1)
  assert.equal(state.aiCallMonitor.counts.ok, 1)
  assert.equal(state.aiCallMonitor.bySource.main_chat.ok, 1)
})

test('executor tags auto-look greet as a blocked non-mainline AI call', async () => {
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      context: { include: true, recentCount: 12, recentWindowSec: 300 },
      maxTokensPerCall: 128,
      maxToolCalls: 1,
      externalCalls: buildDefaultExternalCallPolicy()
    },
    aiRecent: [],
    aiSpend: {
      day: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      month: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const executor = createChatExecutor({
    state,
    bot: { username: 'bot', entity: { position: { x: 0, y: 64, z: 0 } } },
    log: null,
    actionsMod: { install: () => ({ run: async () => ({ ok: true }), dry: async () => ({ ok: true }) }) },
    H,
    defaults,
    now: () => 1000,
    traceChat: () => {},
    pulse: {
      sendChatReply: () => {},
      isUserActive: () => false,
      activateSession: () => {},
      touchConversationSession: () => {}
    },
    memory: {
      longTerm: { buildContext: async () => ({ text: '', refs: [] }) },
      dialogue: { buildPrompt: () => '' }
    },
    people: {
      buildAllProfilesContext: () => '',
      buildAllCommitmentsContext: () => ''
    },
    canAfford: () => ({ ok: true, proj: 0, rem: { day: Infinity, month: Infinity, total: Infinity } }),
    applyUsage: () => {},
    buildGameContext: () => '',
    contextBus: { buildXml: () => '', getStore: () => [] },
    aiCallMonitor: monitor
  })

  await assert.rejects(
    executor.callAI('kuleizi', '打招呼', { topic: 'greet', kind: 'chat', nearby: true }, { inlineUserContent: true, aiCallSource: 'auto_look_greet' }),
    /ai_call_blocked:auto_look_greet/
  )
  assert.equal(state.aiCallMonitor.counts.blocked, 1)
  assert.equal(state.aiCallMonitor.recent.at(-1).source, 'auto_look_greet')
})

test('executor main chat still runs when background AI calls are disabled', async () => {
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      context: { include: true, recentCount: 12, recentWindowSec: 300 },
      maxTokensPerCall: 128,
      maxToolCalls: 1,
      externalCalls: buildDefaultExternalCallPolicy()
    },
    aiRecent: [],
    aiSpend: {
      day: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      month: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    assert.equal(body.model, 'deepseek-chat')
    assert.equal(Array.isArray(body.messages), true)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '主线正常' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      })
    }
  }
  try {
    const executor = createChatExecutor({
      state,
      bot: { username: 'bot', entity: { position: { x: 0, y: 64, z: 0 } } },
      log: null,
      actionsMod: { install: () => ({ run: async () => ({ ok: true }), dry: async () => ({ ok: true }) }) },
      H,
      defaults,
      now: () => 1000,
      traceChat: () => {},
      pulse: {
        sendChatReply: () => {},
        isUserActive: () => false,
        activateSession: () => {},
        touchConversationSession: () => {}
      },
      memory: {
        longTerm: { buildContext: async () => ({ text: '', refs: [] }) },
        dialogue: { buildPrompt: () => '' }
      },
      people: {
        buildAllProfilesContext: () => '',
        buildAllCommitmentsContext: () => ''
      },
      canAfford: () => ({ ok: true, proj: 0, rem: { day: Infinity, month: Infinity, total: Infinity } }),
      applyUsage: () => {},
      buildGameContext: () => '',
      contextBus: { buildXml: () => '', getStore: () => [] },
      aiCallMonitor: monitor
    })
    const res = await executor.callAI('kuleizi', '你好', { topic: 'generic', kind: 'chat' }, { inlineUserContent: true })
    assert.equal(res.reply, '主线正常')
    assert.equal(state.aiCallMonitor.bySource.main_chat.ok, 1)
    assert.equal(state.aiCallMonitor.counts.blocked, 0)
  } finally {
    global.fetch = oldFetch
  }
})
