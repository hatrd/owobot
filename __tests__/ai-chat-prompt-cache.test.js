import test from 'node:test'
import assert from 'node:assert/strict'

import executorMod from '../bot_impl/ai-chat/executor.js'
import H from '../bot_impl/ai-chat-helpers.js'
import defaultsMod from '../bot_impl/ai-chat/config.js'

const { createChatExecutor } = executorMod

test('callAI builds stable prefix first and keeps prefix signature stable', async () => {
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'http://example.com',
      path: '/v1/chat/completions',
      model: 'test-model',
      maxReplyLen: 240,
      maxTokensPerCall: 64,
      timeoutMs: 5000,
      notifyOnBudget: false,
      trace: false,
      context: { include: true, recentCount: 50, recentWindowSec: 3600, recentStoreMax: 50, memory: { include: true, max: 6 } }
    },
    aiCacheStats: { embeddingStore: { lookups: 0, hits: 0, misses: 0 }, promptCache: { calls: 0, promptTokens: 0, cachedTokens: 0, lastPrefixSig: null, last: null } },
    aiStats: { perUser: new Map(), global: [] }
  }

  const bot = { username: 'bot' }
  const log = null

  let nowTs = 1_700_000_000_000
  const now = () => {
    nowTs += 60_000
    return nowTs
  }

  const memory = {
    longTerm: {
      buildContext: async () => ({ text: 'MEMORYCTX', refs: ['ref1'] })
    },
    dialogue: {
      buildPrompt: () => 'DIALOGUECTX'
    }
  }

  const people = {
    buildAllProfilesContext: () => 'PROFILESCTX',
    buildAllCommitmentsContext: () => 'COMMITMENTSCTX'
  }

  const contextBus = {
    buildXml: () => '<ctx/>',
    getStore: () => []
  }

  const calls = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 80 }
        }
      })
    }
  }

  try {
    const executor = createChatExecutor({
      state,
      bot,
      log,
      actionsMod: { install: () => ({ run: async () => ({ ok: true }) }) },
      H,
      defaults: {
        DEFAULT_MODEL: defaultsMod.DEFAULT_MODEL,
        DEFAULT_BASE: defaultsMod.DEFAULT_BASE,
        DEFAULT_PATH: defaultsMod.DEFAULT_PATH,
        DEFAULT_TIMEOUT_MS: defaultsMod.DEFAULT_TIMEOUT_MS,
        DEFAULT_RECENT_COUNT: defaultsMod.DEFAULT_RECENT_COUNT,
        DEFAULT_RECENT_WINDOW_SEC: defaultsMod.DEFAULT_RECENT_WINDOW_SEC
      },
      now,
      traceChat: () => {},
      pulse: {},
      memory,
      people,
      canAfford: () => ({ ok: true, proj: 0, rem: {} }),
      applyUsage: () => {},
      buildGameContext: () => 'GAMECTX',
      contextBus
    })

    const a = await executor.callAI('Alice', 'hello', { topic: 'generic', kind: 'chat' }, { inlineUserContent: true })
    const sig1 = state.aiCacheStats.promptCache.lastPrefixSig
    assert.ok(typeof sig1 === 'string' && sig1.length > 0, 'expected prefix signature')
    assert.equal(a.reply, 'ok')

    const b = await executor.callAI('Alice', 'hello again', { topic: 'generic', kind: 'chat' }, { inlineUserContent: true })
    const sig2 = state.aiCacheStats.promptCache.lastPrefixSig
    assert.equal(sig2, sig1)
    assert.equal(b.reply, 'ok')

    assert.equal(calls.length, 2)
    const body1 = JSON.parse(calls[0].opts.body)
    const body2 = JSON.parse(calls[1].opts.body)
    assert.equal(body1.messages[0].role, 'system')
    assert.equal(body1.messages[0].content.includes('猫娘'), true)
    assert.ok(body1.messages.slice(1).every(m => m.role === 'user'))

    const meta1 = body1.messages.find(m => m.content && String(m.content).includes('现在是北京时间'))
    const meta2 = body2.messages.find(m => m.content && String(m.content).includes('现在是北京时间'))
    assert.ok(meta1 && meta2)
    assert.notEqual(meta1.content, meta2.content)
  } finally {
    global.fetch = originalFetch
  }
})

