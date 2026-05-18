import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatExecutor } from '../bot_impl/ai-chat/executor.js'
import H from '../bot_impl/ai-chat-helpers.js'

const HISTORICAL_2026_02_14_AVG_INPUT_TOKENS = 10843
const HISTORICAL_2026_01_31_AVG_INPUT_TOKENS = 8923

function repeatedText (label, chars) {
  const unit = `${label} 这是一段来自历史日志形态的长聊天内容，用来模拟高上下文日里玩家连续聊天、机器人回复、状态说明和闲聊混杂。`
  let out = ''
  while (out.length < chars) out += unit
  return out.slice(0, chars)
}

function makeRecentFromLogShape ({ count, day, chars }) {
  const base = new Date(`${day}T00:00:00+08:00`).getTime()
  const users = ['kuleizi', 'projekt_melody', 'izieluk', 'Ameyaku', 'owkowk']
  return Array.from({ length: count }, (_, i) => ({
    t: base + i * 60 * 1000,
    user: users[i % users.length],
    text: repeatedText(`${day}#${i}`, chars),
    kind: users[i % users.length] === 'owkowk' ? 'bot' : 'player',
    seq: i + 1
  }))
}

function makeContextBusFromRecent (recent) {
  const store = recent.map((r) => ({
    t: r.t,
    type: r.kind === 'bot' ? 'bot' : 'player',
    payload: r.kind === 'bot' ? { content: r.text } : { name: r.user, content: r.text }
  }))
  return {
    getStore: () => store,
    buildXml: ({ maxEntries }) => {
      const kept = store.slice(-maxEntries)
      return [
        '<context_bus>',
        ...kept.map((e, i) => {
          if (e.type === 'player') return `<p i="${i}" name="${e.payload.name}">${e.payload.content}</p>`
          return `<b i="${i}">${e.payload.content}</b>`
        }),
        '</context_bus>'
      ].join('\n')
    },
    pushEvent: () => {},
    pushTool: () => {}
  }
}

function makeMemory (longText = repeatedText('长期记忆', 2400)) {
  return {
    longTerm: {
      buildContext: async () => ({ text: `长期记忆:\n1. ${longText}`, refs: [] })
    },
    dialogue: {
      buildPrompt: () => `对话摘要:\n${repeatedText('对话摘要', 1600)}`
    }
  }
}

function makeExecutor ({ recent, gameText = repeatedText('游戏状态', 1800), memory = makeMemory(), peopleText = repeatedText('玩家画像', 1200) }) {
  const calls = []
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    calls.push({ url, body })
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '收到' } }],
        usage: {
          prompt_tokens: H.estTokensFromText((body.messages || body.input || []).map(m => m.content || '').join(' ')),
          completion_tokens: 2
        }
      })
    }
  }

  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      context: { include: true, recentCount: 50, recentWindowSec: 24 * 60 * 60 },
      maxTokensPerCall: 1024,
      maxToolCalls: 6
    },
    aiRecent: recent,
    aiSpend: {
      day: { start: Date.now(), inTok: 0, outTok: 0, cost: 0 },
      month: { start: Date.now(), inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const bot = { username: 'owkowk', entity: { position: { x: 0, y: 64, z: 0 } } }
  const executor = createChatExecutor({
    state,
    bot,
    log: null,
    actionsMod: { install: () => ({ run: async () => ({ ok: true, msg: 'ok' }), dry: async () => ({ ok: true, msg: 'dry' }), list: () => [] }) },
    H,
    defaults: {
      DEFAULT_MODEL: 'deepseek-chat',
      DEFAULT_BASE: 'https://example.invalid',
      DEFAULT_PATH: '/v1/chat/completions',
      DEFAULT_TIMEOUT_MS: 1000,
      DEFAULT_RECENT_COUNT: 50,
      DEFAULT_RECENT_WINDOW_SEC: 24 * 60 * 60
    },
    now: () => Date.now(),
    traceChat: () => {},
    pulse: {
      sendChatReply: () => {},
      isUserActive: () => true,
      activateSession: () => {},
      captureAiReply: () => {}
    },
    memory,
    people: {
      buildAllProfilesContext: () => `玩家画像:\n${peopleText}`,
      buildAllCommitmentsContext: () => `承诺:\n${peopleText}`
    },
    canAfford: () => ({ ok: true, proj: 0, rem: { day: Infinity, month: Infinity, total: Infinity } }),
    applyUsage: () => {},
    buildGameContext: () => `游戏上下文:\n${gameText}`,
    contextBus: makeContextBusFromRecent(recent)
  })

  return {
    executor,
    calls,
    restore: () => { global.fetch = oldFetch }
  }
}

function promptTextFromCall (call) {
  return (call.body.messages || call.body.input || []).map(m => m.content || '').join('\n')
}

test('2026-05-16/17 auto-look greet shape sends minimal context under 1200 tokens', async () => {
  const recent = [
    ...makeRecentFromLogShape({ day: '2026-05-16', count: 40, chars: 220 }),
    ...makeRecentFromLogShape({ day: '2026-05-17', count: 54, chars: 220 })
  ]
  const harness = makeExecutor({ recent })
  try {
    await harness.executor.callAI(
      'izieluk',
      '玩家 izieluk 正在你身边并被你注意到，请用一句温暖、自然的中文主动打招呼，鼓励对方继续聊天，控制在20字以内。',
      { topic: 'greet', kind: 'chat', nearby: true },
      { inlineUserContent: true, reason: 'look_greet' }
    )
    assert.equal(harness.calls.length, 1)
    const text = promptTextFromCall(harness.calls[0])
    const tokens = H.estTokensFromText(text)
    assert.ok(tokens < 1200, `expected greet prompt < 1200 tokens, got ${tokens}`)
    assert.doesNotMatch(text, /<context_bus>/)
    assert.doesNotMatch(text, /游戏上下文/)
    assert.doesNotMatch(text, /长期记忆/)
    assert.doesNotMatch(text, /玩家画像/)
    assert.equal(harness.calls[0].body.tools, undefined)
  } finally {
    harness.restore()
  }
})

test('2026-02-14 high-token chat shape is trimmed below 3000 tokens', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-02-14', count: 120, chars: 260 })
  const harness = makeExecutor({ recent })
  try {
    await harness.executor.callAI(
      'kuleizi',
      'owkowk 我回来了哟',
      { topic: 'generic', kind: 'chat' },
      { inlineUserContent: true }
    )
    const text = promptTextFromCall(harness.calls[0])
    const tokens = H.estTokensFromText(text)
    assert.ok(tokens < 3000, `expected normal chat prompt < 3000 tokens, got ${tokens}`)
    assert.ok(tokens < HISTORICAL_2026_02_14_AVG_INPUT_TOKENS, `expected prompt below historical 2026-02-14 avg ${HISTORICAL_2026_02_14_AVG_INPUT_TOKENS}, got ${tokens}`)
    assert.match(text, /长期记忆/)
    assert.match(text, /玩家画像/)
    assert.doesNotMatch(text, /游戏上下文/)
    assert.equal((text.match(/<p |<b /g) || []).length <= 12, true)
    assert.equal(harness.calls[0].body.tools, undefined)
  } finally {
    harness.restore()
  }
})

test('2026-01-31 action/query shape keeps world tools but stays below 5000 tokens', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 80, chars: 240 })
  const harness = makeExecutor({ recent })
  try {
    await harness.executor.callAI(
      'kuleizi',
      'owkowk 看看附近有什么掉落然后捡起来',
      { topic: 'observe', kind: 'action', nearby: true },
      { inlineUserContent: true }
    )
    const text = promptTextFromCall(harness.calls[0])
    const tokens = H.estTokensFromText(text)
    assert.ok(tokens < 5000, `expected action/query prompt < 5000 tokens, got ${tokens}`)
    assert.ok(tokens < HISTORICAL_2026_01_31_AVG_INPUT_TOKENS, `expected prompt below historical 2026-01-31 avg ${HISTORICAL_2026_01_31_AVG_INPUT_TOKENS}, got ${tokens}`)
    assert.match(text, /游戏上下文/)
    assert.match(text, /长期记忆/)
    assert.equal(Array.isArray(harness.calls[0].body.tools), true)
    assert.equal((text.match(/<p |<b /g) || []).length <= 16, true)
  } finally {
    harness.restore()
  }
})

test('plan context keeps broader context but caps log-shaped prompt below plan budget', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-02-14', count: 120, chars: 260 })
  const harness = makeExecutor({ recent })
  try {
    await harness.executor.callAI(
      'kuleizi',
      '继续执行刚才的计划，汇总上一步工具结果后决定下一步。',
      { topic: 'plan', kind: 'chat' },
      { inlineUserContent: true, contextProfile: 'plan' }
    )
    const text = promptTextFromCall(harness.calls[0])
    const tokens = H.estTokensFromText(text)
    assert.ok(tokens < 6500, `expected plan prompt < 6500 tokens, got ${tokens}`)
    assert.ok(tokens < HISTORICAL_2026_02_14_AVG_INPUT_TOKENS, `expected plan prompt below historical avg ${HISTORICAL_2026_02_14_AVG_INPUT_TOKENS}, got ${tokens}`)
    assert.match(text, /游戏上下文/)
    assert.match(text, /长期记忆/)
    assert.match(text, /对话摘要/)
    assert.equal(Array.isArray(harness.calls[0].body.tools), true)
    assert.equal((text.match(/<p |<b /g) || []).length <= 20, true)
  } finally {
    harness.restore()
  }
})
