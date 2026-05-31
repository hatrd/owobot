import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatExecutor } from '../bot_impl/ai-chat/executor.js'
import { createPulseService } from '../bot_impl/ai-chat/pulse.js'
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

function waitFor (predicate, timeoutMs = 3000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve()
      } catch (err) {
        return reject(err)
      }
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function makeHarness ({ llmContent }) {
  const sent = []
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      context: { include: true, recentCount: 12, recentWindowSec: 300 },
      maxTokensPerCall: 128,
      maxToolCalls: 2,
      maxReplyLen: 120
    },
    aiRecent: [],
    aiRecentSeq: 0,
    aiPulse: {},
    aiStats: { global: [], perUser: new Map() },
    aiSpend: {
      day: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      month: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const oldFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: llmContent } }],
      usage: { prompt_tokens: 10, completion_tokens: 12 }
    })
  })

  const bot = {
    username: 'owkowk',
    entity: { position: { x: 0, y: 64, z: 0 } },
    chat: (text) => { sent.push(String(text)) }
  }
  const memory = {
    longTerm: {
      buildContext: async () => ({ text: '', refs: [] }),
      extractForgetCommand: () => null,
      extractCommand: () => null,
      persistState: () => {}
    },
    dialogue: {
      buildPrompt: () => '',
      maybeRunAggregation: () => {},
      queueSummary: () => {}
    }
  }
  const contextBus = {
    buildXml: () => '',
    getStore: () => [],
    pushBot: () => {},
    pushBotFrom: () => {},
    pushPlayer: () => {},
    pushEvent: () => {},
    pushTool: () => {}
  }
  const pulse = createPulseService({
    state,
    bot,
    log: null,
    now: () => Date.now(),
    H,
    defaults,
    canAfford: () => ({ ok: true }),
    applyUsage: () => {},
    buildContextPrompt: () => '',
    buildGameContext: () => '',
    traceChat: () => {},
    memory,
    feedbackCollector: null,
    contextBus
  })
  const executor = createChatExecutor({
    state,
    bot,
    log: null,
    actionsMod: { install: () => ({ run: async () => ({ ok: true, msg: 'ok' }), dry: async () => ({ ok: true, msg: 'dry' }) }) },
    H,
    defaults,
    now: () => Date.now(),
    traceChat: () => {},
    pulse,
    memory,
    people: { buildAllProfilesContext: () => '', buildAllCommitmentsContext: () => '' },
    canAfford: () => ({ ok: true, proj: 0, rem: { day: Infinity, month: Infinity, total: Infinity } }),
    applyUsage: () => {},
    buildGameContext: () => '',
    contextBus
  })

  return {
    executor,
    sent,
    cleanup: () => {
      try { pulse.stop() } catch {}
      global.fetch = oldFetch
    }
  }
}

test('executor treats production LLM say{} text as a say tool instead of literal chat', async () => {
  const productionText = 'say{"steps":["没发呆喵！","刚刚在想事情啦~"]}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('zileiku', '在想什么嘛', 'owkowk 在想什么嘛', 'trigger')
    await waitFor(() => harness.sent.length >= 2 || harness.sent.some(line => line.includes('say{')))
    assert.deepEqual(harness.sent, ['没发呆喵！', '刚刚在想事情啦~'])
    assert.equal(harness.sent.some(line => line.includes('say{')), false)
  } finally {
    harness.cleanup()
  }
})
