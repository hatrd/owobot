import test from 'node:test'
import assert from 'node:assert/strict'

import registerMovement from '../bot_impl/actions/modules/movement.js'
import helpers from '../bot_impl/ai-chat-helpers.js'
import executorMod from '../bot_impl/ai-chat/executor.js'

test('movement.follow_player falls back to /tpa when player entity not found', async () => {
  const registry = new Map()
  const bot = {
    username: 'bot',
    state: { aiRecent: [] },
    players: {},
    entities: {},
    chat: () => {}
  }
  let chatCalls = 0
  bot.chat = (msg) => { chatCalls++; bot._lastChat = msg }

  registerMovement({
    bot,
    register: (name, fn) => registry.set(name, fn),
    ok: (msg) => ({ ok: true, msg }),
    fail: (msg) => ({ ok: false, msg }),
    ensurePathfinder: () => { throw new Error('should not require pathfinder for fallback') },
    wait: async () => {},
    shared: {},
    pvp: { stopMoveOverrides: () => {} },
    Vec3: function Vec3 () {}
  })

  const res1 = await registry.get('follow_player')({ name: 'owkowk' })
  assert.equal(res1.ok, true)
  assert.equal(res1.msg, '')
  assert.equal(bot._lastChat, '/tpa owkowk')
  assert.equal(chatCalls, 1)
  assert.equal(bot.state.aiRecent.at(-1)?.text, '/tpa owkowk')

  const res2 = await registry.get('follow_player')({ name: 'owkowk' })
  assert.equal(res2.ok, true)
  assert.equal(res2.msg, '')
  assert.equal(chatCalls, 1)
})

test('movement.follow_player rejects unsafe player names', async () => {
  const registry = new Map()
  const bot = { username: 'bot', state: {}, players: {}, entities: {}, chat: () => { throw new Error('should not chat') } }
  registerMovement({
    bot,
    register: (name, fn) => registry.set(name, fn),
    ok: (msg) => ({ ok: true, msg }),
    fail: (msg) => ({ ok: false, msg }),
    ensurePathfinder: () => true,
    wait: async () => {},
    shared: {},
    pvp: { stopMoveOverrides: () => {} },
    Vec3: function Vec3 () {}
  })

  const res = await registry.get('follow_player')({ name: 'bad name; /op' })
  assert.equal(res.ok, false)
  assert.equal(res.msg, '玩家名不合法')
})

test('executor does not auto-ack or success-reply for follow_player tool', async () => {
  const { createChatExecutor } = executorMod
  const calls = []
  const pulse = { sendChatReply: (...args) => calls.push(args), activateSession: () => {}, touchConversationSession: () => {}, cancelSay: () => {}, resetActiveSessions: () => {} }

  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'http://ai.test',
      path: '/v1/chat/completions',
      maxTokensPerCall: 120
    },
    aiRecent: [],
    aiPulse: {}
  }

  const executor = createChatExecutor({
    state,
    bot: { username: 'bot', entity: { position: null }, game: {}, emit: () => {} },
    log: { info: () => {}, warn: () => {} },
    actionsMod: { install: () => ({ run: async () => ({ ok: true, msg: '' }) }) },
    H: helpers,
    defaults: { DEFAULT_TIMEOUT_MS: 5000, DEFAULT_MODEL: 'gpt-test', DEFAULT_BASE: 'http://ai.test', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_RECENT_COUNT: 50, DEFAULT_RECENT_WINDOW_SEC: 3600 },
    now: () => Date.now(),
    traceChat: () => {},
    pulse,
    memory: {
      dialogue: { buildPrompt: () => '' },
      longTerm: { buildContext: async () => ({ text: '', refs: [] }), extractCommand: () => null }
    },
    canAfford: () => ({ ok: true, proj: 0, rem: {} }),
    applyUsage: () => {},
    buildGameContext: () => ''
  })

  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url || '').startsWith('http://ai.test')) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: '1', function: { name: 'follow_player', arguments: JSON.stringify({ name: 'owkowk' }) } }]
              }
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        }
      }
      if (typeof origFetch === 'function') return origFetch(url, options)
      throw new Error('fetch not available')
    }

    await executor.processChatContent('kuleizi', 'follow owkowk', 'follow owkowk', 'trigger')
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = origFetch
  }
})
