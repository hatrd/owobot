import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAiCallMonitor, buildDefaultExternalCallPolicy } from '../bot_impl/ai-chat/call-monitor.js'
import { prepareAiState } from '../bot_impl/ai-chat/state-init.js'
import { prepareSharedState } from '../bot_impl/state.js'
import { createChatExecutor } from '../bot_impl/ai-chat/executor.js'
import memoryMod from '../bot_impl/ai-chat/memory.js'
import aiChatMod from '../bot_impl/ai-chat.js'
import H from '../bot_impl/ai-chat-helpers.js'

const { createMemoryService } = memoryMod
const { install: installAiChat } = aiChatMod

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

test('AI call monitor applies state timeout when callers omit an explicit signal', async () => {
  const state = {
    ai: {
      timeoutMs: 5,
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    }
  }
  const monitor = createAiCallMonitor({ state, now: () => Date.now() })
  let signalSeen = null

  await assert.rejects(
    monitor.request({
      source: 'conversation_summary',
      kind: 'chat',
      model: 'deepseek-chat',
      url: 'https://example.invalid/v1/chat/completions',
      body: { model: 'deepseek-chat', messages: [] },
      fetchImpl: async (_url, init) => {
        signalSeen = init?.signal || null
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error('aborted_by_timeout'))
          signalSeen?.addEventListener?.('abort', onAbort, { once: true })
        })
      }
    }),
    /aborted_by_timeout/
  )

  assert.ok(signalSeen)
  assert.equal(state.aiCallMonitor.bySource.conversation_summary.error, 1)
  assert.equal(state.aiCallMonitor.recent.at(-1).status, 'error')
})

test('background toggle does not implicitly allow expensive chained LLM sources', async () => {
  const state = {
    ai: {
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    }
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })

  await assert.rejects(
    monitor.request({
      source: 'people_inspector',
      kind: 'chat',
      model: 'deepseek-chat',
      url: 'https://example.invalid/v1/chat/completions',
      body: { model: 'deepseek-chat', messages: [] },
      fetchImpl: async () => ({ ok: true, status: 200 })
    }),
    /ai_call_blocked:people_inspector/
  )

  await assert.rejects(
    monitor.request({
      source: 'dialogue_aggregation',
      kind: 'chat',
      model: 'deepseek-chat',
      url: 'https://example.invalid/v1/chat/completions',
      body: { model: 'deepseek-chat', messages: [] },
      fetchImpl: async () => ({ ok: true, status: 200 })
    }),
    /ai_call_blocked:dialogue_aggregation/
  )

  assert.equal(state.aiCallMonitor.bySource.people_inspector.blocked, 1)
  assert.equal(state.aiCallMonitor.bySource.dialogue_aggregation.blocked, 1)
})

test('explicit allowSources can still enable expensive chained LLM sources', async () => {
  const state = {
    ai: {
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'people_inspector'] }
    }
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const res = await monitor.request({
    source: 'people_inspector',
    kind: 'chat',
    model: 'deepseek-chat',
    url: 'https://example.invalid/v1/chat/completions',
    body: { model: 'deepseek-chat', messages: [] },
    fetchImpl: async () => ({ ok: true, status: 200 })
  })

  assert.equal(res.ok, true)
  assert.equal(state.aiCallMonitor.bySource.people_inspector.ok, 1)
})

test('memory rewrite does not retry monitor-blocked background calls', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      timeoutMs: 1000,
      externalCalls: buildDefaultExternalCallPolicy()
    },
    aiMemory: {
      entries: [],
      queue: [{
        id: 'job_blocked',
        player: 'Alice',
        text: '记住基地在这里',
        original: '记住基地在这里',
        recent: []
      }]
    },
    aiRecent: []
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const memory = createMemoryService({
    state,
    memoryStore: { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) },
    defaults,
    bot: { username: 'bot' },
    aiCallMonitor: monitor,
    now: () => 1000
  })

  await memory.rewrite.processQueue()

  assert.equal(state.aiCallMonitor.bySource.memory_rewrite.blocked, 1)
  assert.equal(state.aiMemory.queue.length, 0)
})

test('memory rewrite does not retry permanent HTTP errors', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      timeoutMs: 1000,
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiMemory: {
      entries: [],
      queue: [{
        id: 'job_unauthorized',
        player: 'Alice',
        text: '记住基地在这里',
        original: '记住基地在这里',
        recent: []
      }]
    },
    aiRecent: []
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const oldFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls += 1
    return {
      ok: false,
      status: 401,
      text: async () => 'unauthorized'
    }
  }
  try {
    const memory = createMemoryService({
      state,
      memoryStore: { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) },
      defaults,
      bot: { username: 'bot' },
      aiCallMonitor: monitor,
      now: () => 1000
    })

    await memory.rewrite.processQueue()

    assert.equal(calls, 1)
    assert.equal(state.aiCallMonitor.bySource.memory_rewrite.error, 1)
    assert.equal(state.aiMemory.queue.length, 0)
  } finally {
    global.fetch = oldFetch
  }
})

test('memory rewrite sends compact payload and small output budget when background is enabled', async () => {
  const longText = '这是一段很长的记忆内容，包含玩家描述的位置、路线、偏好和上下文。'.repeat(120)
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      timeoutMs: 1000,
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiMemory: {
      entries: Array.from({ length: 30 }, (_, i) => ({
        instruction: `${i}: ${longText}`,
        text: `${i}: ${longText}`,
        triggers: [`触发词${i}`, longText]
      })),
      queue: [{
        id: 'job_compact',
        player: 'Alice',
        text: longText,
        original: `owk 记住 ${longText}`,
        recent: Array.from({ length: 20 }, (_, i) => ({ user: i % 2 ? 'Bob' : 'Alice', text: `${i}: ${longText}` })),
        context: { position: { x: 1, y: 64, z: 2 }, dimension: 'minecraft:overworld', radius: 50, featureHint: longText }
      }]
    },
    aiRecent: []
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const oldFetch = global.fetch
  let requestBody = null
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body || '{}'))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"status":"reject","reason":"测试"}' } }]
      })
    }
  }
  try {
    const memory = createMemoryService({
      state,
      memoryStore: { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) },
      defaults,
      bot: { username: 'bot' },
      aiCallMonitor: monitor,
      now: () => 1000
    })

    await memory.rewrite.processQueue()

    assert.ok(requestBody, 'expected memory_rewrite request')
    assert.ok(Number(requestBody.max_tokens) <= 256, `expected memory_rewrite max_tokens <= 256, got ${requestBody.max_tokens}`)
    const messages = Array.isArray(requestBody.messages) ? requestBody.messages : requestBody.input
    const userPrompt = String(messages?.find(m => m.role === 'user')?.content || '')
    assert.ok(userPrompt.length <= 3600, `expected compact memory_rewrite payload <= 3600 chars, got ${userPrompt.length}`)
    const payload = JSON.parse(userPrompt)
    assert.ok(String(payload.request || '').length <= 600)
    assert.ok(String(payload.original_message || '').length <= 600)
    assert.ok(Array.isArray(payload.recent_chat) && payload.recent_chat.length <= 4)
    assert.ok(Array.isArray(payload.existing_triggers) && payload.existing_triggers.length <= 6)
  } finally {
    global.fetch = oldFetch
  }
})

test('memory rewrite dedupes duplicate pending jobs before external calls', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      timeoutMs: 1000,
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiMemory: {
      entries: [],
      queue: [
        {
          id: 'job_duplicate_1',
          player: 'Alice',
          text: '基地在这里',
          original: '记住基地在这里',
          recent: []
        },
        {
          id: 'job_duplicate_2',
          player: 'Alice',
          text: '基地在这里',
          original: '请记住 基地在这里',
          recent: []
        }
      ]
    },
    aiRecent: []
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const oldFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"status":"reject","reason":"重复测试"}' } }]
      })
    }
  }
  try {
    const memory = createMemoryService({
      state,
      memoryStore: { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) },
      defaults,
      bot: { username: 'bot' },
      aiCallMonitor: monitor,
      now: () => 1000
    })

    await memory.rewrite.processQueue()

    assert.equal(calls, 1)
    assert.equal(state.aiCallMonitor.bySource.memory_rewrite.ok, 1)
    assert.equal(state.aiMemory.queue.length, 0)
  } finally {
    global.fetch = oldFetch
  }
})

test('memory rewrite caps external calls per queue run', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      timeoutMs: 1000,
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiMemory: {
      entries: [],
      queue: Array.from({ length: 6 }, (_, i) => ({
        id: `job_burst_${i}`,
        player: 'Alice',
        text: `基地记忆 ${i}`,
        original: `记住基地记忆 ${i}`,
        recent: []
      }))
    },
    aiRecent: []
  }
  const monitor = createAiCallMonitor({ state, now: () => 1000 })
  const oldFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"status":"reject","reason":"测试"}' } }]
      })
    }
  }
  try {
    const memory = createMemoryService({
      state,
      memoryStore: { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) },
      defaults,
      bot: { username: 'bot' },
      aiCallMonitor: monitor,
      now: () => 1000
    })

    await memory.rewrite.processQueue()

    assert.equal(calls, 2)
    assert.equal(state.aiCallMonitor.bySource.memory_rewrite.ok, 2)
    assert.equal(state.aiMemory.queue.length, 4)
  } finally {
    global.fetch = oldFetch
  }
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
        longTerm: {
          buildContext: async () => ({ text: '', refs: [] }),
          extractCommand: () => null,
          extractForgetCommand: () => null
        },
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

test('executor coalesces rapid pending followups into one request interrupt', async () => {
  let t = 1000
  const now = () => t
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
    aiPulse: {},
    aiStats: { perUser: new Map() },
    aiRecent: [],
    aiSpend: {
      day: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      month: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const monitor = createAiCallMonitor({ state, now })
  const oldFetch = global.fetch
  let abortCount = 0
  let releaseFirst = null
  let calls = 0
  global.fetch = async (_url, init) => {
    calls += 1
    const signal = init?.signal
    if (calls === 1) {
      signal?.addEventListener?.('abort', () => { abortCount += 1 })
      await new Promise(resolve => { releaseFirst = resolve })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: '第一轮' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 }
        })
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '合并回复' } }],
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
      now,
      traceChat: () => {},
      pulse: {
        sendChatReply: () => {},
        isUserActive: () => true,
        activateSession: () => {},
        touchConversationSession: () => {}
      },
      memory: {
        longTerm: {
          buildContext: async () => ({ text: '', refs: [] }),
          extractCommand: () => null,
          extractForgetCommand: () => null
        },
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

    const first = executor.handleChat('Alice', 'bot 你好')
    await new Promise(resolve => setTimeout(resolve, 20))
    t += 100
    await executor.handleChat('Alice', '还有一句')
    t += 100
    await executor.handleChat('Alice', '再补一句')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(abortCount, 1)
    releaseFirst()
    await first
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(calls, 2)
  } finally {
    global.fetch = oldFetch
  }
})

test('executor delays and merges idle followups into one main chat call', async () => {
  let t = 1000
  const now = () => t
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
      followupDelayMs: 40,
      externalCalls: buildDefaultExternalCallPolicy()
    },
    aiPulse: {},
    aiStats: { perUser: new Map() },
    aiRecent: [],
    aiSpend: {
      day: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      month: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const monitor = createAiCallMonitor({ state, now })
  const oldFetch = global.fetch
  const bodies = []
  global.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    bodies.push(body)
    const text = bodies.length === 1 ? '触发回复' : '合并跟进'
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: text } }],
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
      now,
      traceChat: () => {},
      pulse: {
        sendChatReply: () => {},
        isUserActive: () => true,
        activateSession: () => {},
        touchConversationSession: () => {}
      },
      memory: {
        longTerm: {
          buildContext: async () => ({ text: '', refs: [] }),
          extractCommand: () => null,
          extractForgetCommand: () => null
        },
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

    await executor.handleChat('Alice', 'bot 你好')
    assert.equal(bodies.length, 1)

    t += 100
    await executor.handleChat('Alice', '还有一句')
    t += 100
    await executor.handleChat('Alice', '再补一句')
    assert.equal(bodies.length, 1, 'followups should wait for the silence window instead of calling LLM immediately')

    await new Promise(resolve => setTimeout(resolve, 70))
    assert.equal(bodies.length, 2)
    assert.equal(state.aiCallMonitor.bySource.main_chat.ok, 2)
    const text = (bodies[1].messages || bodies[1].input || []).map(m => m.content || '').join('\n')
    assert.match(text, /还有一句/)
    assert.match(text, /再补一句/)
  } finally {
    global.fetch = oldFetch
  }
})

test('AI chat install processes duplicate player chat events as one billable main chat call', async () => {
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      refsEnabled: false,
      context: {
        include: true,
        recentCount: 4,
        recentWindowSec: 300,
        game: { include: false },
        memory: { include: false }
      },
      maxTokensPerCall: 128,
      maxToolCalls: 1,
      externalCalls: buildDefaultExternalCallPolicy()
    },
    aiRecent: [],
    aiRecentSeq: 0,
    aiSpend: {
      day: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      month: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const bot = new EventEmitter()
  bot.username = 'owkowk'
  bot.chat = () => {}
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.health = 20
  bot.food = 20
  const cleanups = []
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async (_url, init) => {
    fetchCalls += 1
    const body = JSON.parse(String(init?.body || '{}'))
    assert.equal(body.model, 'deepseek-chat')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '收到' } }],
        usage: { prompt_tokens: 12, completion_tokens: 2 }
      })
    }
  }
  try {
    installAiChat(bot, {
      on: (event, handler) => bot.on(event, handler),
      dlog: () => {},
      state,
      registerCleanup: fn => cleanups.push(fn),
      log: null
    })

    bot.emit('chat', 'kuleizi', 'owk 你好')
    bot.emit('chat', 'kuleizi', 'owk 你好')
    await new Promise(resolve => setTimeout(resolve, 80))

    assert.equal(fetchCalls, 1)
    assert.equal(state.aiCallMonitor.bySource.main_chat.ok, 1)
    assert.equal(state.aiRecent.filter(row => row.kind === 'player').length, 1)
  } finally {
    for (const fn of cleanups.reverse()) {
      try { fn() } catch {}
    }
    global.fetch = oldFetch
  }
})
