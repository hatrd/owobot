import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatExecutor } from '../bot_impl/ai-chat/executor.js'
import H from '../bot_impl/ai-chat-helpers.js'
import ctxMod from '../bot_impl/ai-chat/context-bus.js'

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

function makeRealContextBusFromRecent (recent) {
  const state = { ai: { context: {} } }
  let t = 1
  const bus = ctxMod.createContextBus({ state, now: () => t })
  for (const row of recent) {
    t = Number.isFinite(row.t) ? row.t : t + 1000
    if (row.kind === 'bot') bus.pushBotFrom(row.text, 'LLM')
    else if (row.kind === 'tool') bus.pushTool(row.text)
    else if (row.kind === 'server') bus.pushServer(row.text)
    else bus.pushPlayer(row.user || 'player', row.text)
  }
  return bus
}

function makeMemory (longText = repeatedText('长期记忆', 2400)) {
  return {
    longTerm: {
      buildContext: async () => ({ text: `长期记忆:\n1. ${longText}`, refs: [] }),
      extractCommand: () => null,
      extractForgetCommand: () => null
    },
    dialogue: {
      buildPrompt: () => `对话摘要:\n${repeatedText('对话摘要', 1600)}`
    }
  }
}

function makeExecutor ({
  recent,
  gameText = repeatedText('游戏状态', 1800),
  memory = makeMemory(),
  peopleText = repeatedText('玩家画像', 1200),
  people = null,
  assistantContent = '收到',
  assistantMessages = null,
  contextBus = null
}) {
  const calls = []
  const sent = []
  const queuedMessages = Array.isArray(assistantMessages) ? assistantMessages.slice() : null
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    calls.push({ url, body })
    const message = queuedMessages
      ? (queuedMessages.shift() || { role: 'assistant', content: assistantContent })
      : { role: 'assistant', content: assistantContent }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message }],
        usage: {
          prompt_tokens: H.estTokensFromText((body.messages || body.input || []).map(m => m.content || '').join(' ')),
          completion_tokens: H.estTokensFromText(String(message.content || ''))
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
      sendChatReply: (username, text, meta = {}) => { sent.push({ username, text, meta }) },
      isUserActive: () => true,
      activateSession: () => {},
      touchConversationSession: () => {},
      captureAiReply: () => {}
    },
    memory,
    people: people || {
      buildAllProfilesContext: () => `玩家画像:\n${peopleText}`,
      buildAllCommitmentsContext: () => `承诺:\n${peopleText}`
    },
    canAfford: () => ({ ok: true, proj: 0, rem: { day: Infinity, month: Infinity, total: Infinity } }),
    applyUsage: () => {},
    buildGameContext: () => `游戏上下文:\n${gameText}`,
    contextBus: contextBus || makeContextBusFromRecent(recent)
  })

  return {
    executor,
    calls,
    sent,
    restore: () => { global.fetch = oldFetch }
  }
}

function promptTextFromCall (call) {
  return (call.body.messages || call.body.input || []).map(m => m.content || '').join('\n')
}

function providerInputTokensFromCall (call) {
  const messageTokens = H.estTokensFromText(promptTextFromCall(call))
  const toolTokens = Array.isArray(call.body.tools) ? H.estTokensFromText(JSON.stringify(call.body.tools)) : 0
  return messageTokens + toolTokens
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
    assert.ok(Number(harness.calls[0].body.max_tokens) <= 160, `expected greet max_tokens <= 160, got ${harness.calls[0].body.max_tokens}`)
  } finally {
    harness.restore()
  }
})

test('context profiles cap completion budget by conversation shape', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-02-14', count: 30, chars: 160 })
  const cases = [
    {
      name: 'chat',
      args: ['Alice', 'owkowk 你好呀', { topic: 'generic', kind: 'chat' }, { inlineUserContent: true }],
      max: 384
    },
    {
      name: 'action',
      args: ['Alice', 'owkowk 看看附近有什么掉落然后捡起来', { topic: 'observe', kind: 'action', nearby: true }, { inlineUserContent: true }],
      max: 640
    },
    {
      name: 'plan',
      args: ['Alice', '继续执行计划并汇总上一步工具结果', { topic: 'plan', kind: 'chat' }, { inlineUserContent: true, contextProfile: 'plan' }],
      max: 768
    }
  ]

  for (const item of cases) {
    const harness = makeExecutor({ recent })
    try {
      await harness.executor.callAI(...item.args)
      assert.equal(harness.calls.length, 1)
      const maxTokens = Number(harness.calls[0].body.max_tokens)
      assert.ok(maxTokens <= item.max, `expected ${item.name} max_tokens <= ${item.max}, got ${maxTokens}`)
      assert.ok(maxTokens >= 120, `expected ${item.name} max_tokens >= 120, got ${maxTokens}`)
    } finally {
      harness.restore()
    }
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

test('chat profile enforces maxInputTokens even when memory and people context grow', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-02-14', count: 120, chars: 320 })
  const hugeMemory = makeMemory(repeatedText('膨胀长期记忆', 20000))
  const harness = makeExecutor({
    recent,
    memory: hugeMemory,
    peopleText: repeatedText('膨胀玩家画像', 16000)
  })
  try {
    await harness.executor.callAI(
      'kuleizi',
      'owkowk 你好呀',
      { topic: 'generic', kind: 'chat' },
      { inlineUserContent: true }
    )
    const text = promptTextFromCall(harness.calls[0])
    const tokens = H.estTokensFromText(text)
    assert.ok(tokens <= 3000, `expected chat prompt <= 3000 tokens, got ${tokens}`)
    assert.match(text, /长期记忆/)
    assert.match(text, /玩家画像/)
    assert.match(text, /当前对话玩家/)
  } finally {
    harness.restore()
  }
})

test('chat profile scopes people context to the active player', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-02-14', count: 20, chars: 120 })
  const harness = makeExecutor({
    recent,
    people: {
      buildAllProfilesContext: ({ player } = {}) => {
        assert.equal(player, 'Alice')
        return '<people>\n<profile n="Alice">喜欢被叫阿猫</profile>\n</people>'
      },
      buildAllCommitmentsContext: ({ player } = {}) => {
        assert.equal(player, 'Alice')
        return '承诺（未完成）：\nAlice：帮 Alice 找回家路线'
      }
    }
  })
  try {
    await harness.executor.callAI(
      'Alice',
      'owkowk 你还记得我是谁吗',
      { topic: 'generic', kind: 'chat' },
      { inlineUserContent: true }
    )
    const text = promptTextFromCall(harness.calls[0])
    assert.match(text, /Alice/)
    assert.doesNotMatch(text, /Bob/)
  } finally {
    harness.restore()
  }
})

test('chat prompt caps repeated bot/tool context bus echoes without dropping player turns', async () => {
  const now = Date.now()
  const recent = []
  for (let i = 0; i < 10; i++) {
    recent.push({ t: now + i * 3000, user: 'Alice', text: `玩家问题 ${i}`, kind: 'player' })
    recent.push({ t: now + i * 3000 + 1000, user: 'owkowk', text: repeatedText(`机器人长回复${i}`, 180), kind: 'bot' })
    recent.push({ t: now + i * 3000 + 2000, user: 'tool', text: repeatedText(`工具长结果${i}`, 180), kind: 'tool' })
  }
  const harness = makeExecutor({
    recent,
    contextBus: makeRealContextBusFromRecent(recent)
  })
  try {
    await harness.executor.callAI(
      'Alice',
      'owkowk 继续说',
      { topic: 'generic', kind: 'chat' },
      { inlineUserContent: true }
    )
    const text = promptTextFromCall(harness.calls[0])
    assert.equal((text.match(/<p n="Alice">/g) || []).length, 3)
    assert.ok((text.match(/<b f="LLM">/g) || []).length <= 3)
    assert.ok((text.match(/<b f="tool">/g) || []).length <= 3)
    assert.ok(H.estTokensFromText(text) < 3000)
  } finally {
    harness.restore()
  }
})

test('chat profile does not spend prompt tokens on unrelated people records', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-02-14', count: 20, chars: 120 })
  const unrelated = Array.from({ length: 80 }, (_, i) => `<profile n="Other${i}">${repeatedText(`无关画像${i}`, 120)}</profile>`).join('\n')
  const harness = makeExecutor({
    recent,
    people: {
      buildAllProfilesContext: ({ player } = {}) => {
        assert.equal(player, 'Alice')
        return '<people>\n<profile n="Alice">喜欢被叫阿猫</profile>\n</people>'
      },
      buildAllCommitmentsContext: ({ player } = {}) => {
        assert.equal(player, 'Alice')
        return ''
      }
    }
  })
  try {
    await harness.executor.callAI(
      'Alice',
      'owkowk 我想确认你记得我的称呼',
      { topic: 'generic', kind: 'chat' },
      { inlineUserContent: true }
    )
    const text = promptTextFromCall(harness.calls[0])
    const scopedTokens = H.estTokensFromText(text)
    const oldFullPeopleTokens = H.estTokensFromText(`${text}\n${unrelated}`)
    assert.ok(scopedTokens < oldFullPeopleTokens / 3, `expected scoped prompt to avoid unrelated people records: scoped=${scopedTokens}, old=${oldFullPeopleTokens}`)
    assert.doesNotMatch(text, /Other0/)
    assert.doesNotMatch(text, /无关画像/)
  } finally {
    harness.restore()
  }
})

test('non-action Chinese chat containing 打 stays on lightweight chat profile', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-02-14', count: 80, chars: 220 })
  const harness = makeExecutor({
    recent,
    gameText: repeatedText('不该注入的游戏状态', 6000),
    memory: makeMemory(repeatedText('普通长期记忆', 1000)),
    peopleText: repeatedText('普通画像', 900)
  })
  try {
    await harness.executor.processChatContent(
      'Alice',
      '打扰一下，陪我聊聊天可以吗',
      'owkowk 打扰一下，陪我聊聊天可以吗',
      'trigger'
    )
    assert.equal(harness.calls.length, 1)
    const call = harness.calls[0]
    assert.equal(call.body.tools, undefined)
    const text = promptTextFromCall(call)
    assert.doesNotMatch(text, /不该注入的游戏状态/)
    assert.ok(providerInputTokensFromCall(call) <= 3000, `expected lightweight chat input <= 3000 tokens, got ${providerInputTokensFromCall(call)}`)
  } finally {
    harness.restore()
  }
})

test('intent-scoped tool turns do not execute inline text tools outside the selected schema', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 10, chars: 80 })
  const harness = makeExecutor({
    recent,
    assistantContent: 'skill_start{"name":"mine"}'
  })
  try {
    const res = await harness.executor.dryDialogue(
      'kuleizi',
      'owkowk 看看附近有什么掉落然后捡起来',
      { withTools: true, maxToolCalls: 2, intent: { topic: 'observe', kind: 'action', nearby: true } }
    )
    const calledTools = (res.dryEvents || []).filter(e => e.type === 'tool.call').map(e => e.tool)
    assert.equal(calledTools.includes('skill_start'), false, 'skill_start must not bypass intent-scoped tools via inline text')
  } finally {
    harness.restore()
  }
})

test('tool loop does not repeat identical tool calls from a stuck model', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 10, chars: 80 })
  const harness = makeExecutor({
    recent,
    assistantContent: 'observe_detail{"what":"entities","radius":32,"max":20}'
  })
  try {
    const res = await harness.executor.dryDialogue(
      'kuleizi',
      'owkowk 看看附近有什么实体',
      { withTools: true, maxToolCalls: 3, intent: { topic: 'observe', kind: 'action', nearby: true } }
    )
    const calledTools = (res.dryEvents || []).filter(e => e.type === 'tool.call').map(e => e.tool)
    assert.deepEqual(calledTools, ['observe_detail'])
    assert.ok(harness.calls.length <= 2, `expected at most one follow-up model call after observe, got ${harness.calls.length}`)
  } finally {
    harness.restore()
  }
})

test('deterministic commitment tool halts without a second model call', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 10, chars: 80 })
  const harness = makeExecutor({
    recent,
    assistantMessages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_commitment_1',
            type: 'function',
            function: {
              name: 'add_commitment',
              arguments: JSON.stringify({ player: 'Alice', action: '帮 Alice 找回家路线' })
            }
          }
        ]
      },
      { role: 'assistant', content: '二次总结不应该发生' }
    ],
    people: {
      upsertCommitment: () => ({ ok: true }),
      buildAllProfilesContext: () => '<people><profile n="Alice">测试玩家</profile></people>',
      buildAllCommitmentsContext: () => ''
    }
  })
  try {
    const res = await harness.executor.callAI(
      'Alice',
      'owkowk 记得帮我找回家路线',
      { topic: 'plan', kind: 'chat' },
      { inlineUserContent: true, contextProfile: 'plan' }
    )
    assert.equal(harness.calls.length, 1, `expected commitment tool to avoid follow-up LLM call, got ${harness.calls.length}`)
    assert.equal(res.reply, '')
    assert.equal(harness.sent.length, 1)
    assert.match(harness.sent[0].text, /帮 Alice 找回家路线/)
  } finally {
    harness.restore()
  }
})

test('long action tool result halts without a second model call', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 10, chars: 80 })
  const harness = makeExecutor({
    recent,
    assistantMessages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_goto_1',
            type: 'function',
            function: {
              name: 'goto',
              arguments: JSON.stringify({ x: 1, y: 64, z: 1 })
            }
          }
        ]
      },
      { role: 'assistant', content: '二次总结不应该发生' }
    ]
  })
  try {
    const res = await harness.executor.callAI(
      'kuleizi',
      'owkowk 去 1 64 1',
      { topic: 'generic', kind: 'action', nearby: true },
      { inlineUserContent: true }
    )
    assert.equal(harness.calls.length, 1, `expected long action tool to avoid follow-up LLM call, got ${harness.calls.length}`)
    assert.equal(res.reply, '')
    assert.equal(harness.sent.length, 1)
    assert.match(harness.sent[0].text, /ok|完成/)
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
    const toolNames = harness.calls[0].body.tools.map(tool => tool?.function?.name).filter(Boolean)
    const toolTokens = H.estTokensFromText(JSON.stringify(harness.calls[0].body.tools))
    assert.ok(toolTokens < 1500, `expected intent-scoped tool schema < 1500 tokens, got ${toolTokens}`)
    assert.ok(toolNames.includes('observe_detail'), 'observe request should expose observe_detail')
    assert.ok(toolNames.includes('pickup'), 'drop pickup request should expose pickup')
    assert.ok(toolNames.includes('say'), 'tool turns should still expose say')
    assert.equal(toolNames.includes('skill_start'), false, 'unrelated skill tools should not be sent')
    assert.equal((text.match(/<p |<b /g) || []).length <= 16, true)
  } finally {
    harness.restore()
  }
})

test('task profile accounts for tool schema inside the provider input budget', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 100, chars: 320 })
  const harness = makeExecutor({
    recent,
    gameText: repeatedText('膨胀游戏状态', 8000),
    memory: makeMemory(repeatedText('膨胀长期记忆', 12000)),
    peopleText: repeatedText('膨胀玩家画像', 9000)
  })
  try {
    await harness.executor.callAI(
      'kuleizi',
      'owkowk 去基地帮我整理箱子并拿些木头',
      { topic: 'generic', kind: 'action', nearby: true },
      { inlineUserContent: true }
    )
    const call = harness.calls[0]
    assert.equal(Array.isArray(call.body.tools), true)
    const totalTokens = providerInputTokensFromCall(call)
    assert.ok(totalTokens <= 5000, `expected task provider input <= 5000 tokens including tools, got ${totalTokens}`)
    const text = promptTextFromCall(call)
    assert.match(text, /去基地帮我整理箱子/)
    assert.match(text, /当前对话玩家/)
    const toolNames = call.body.tools.map(tool => tool?.function?.name).filter(Boolean)
    assert.ok(toolNames.includes('observe_detail'))
    assert.ok(toolNames.includes('goto'))
    assert.ok(toolNames.includes('collect'))
  } finally {
    harness.restore()
  }
})

test('generic action uses a narrow default tool schema without unrelated resource tools', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 40, chars: 180 })
  const harness = makeExecutor({ recent })
  try {
    await harness.executor.callAI(
      'kuleizi',
      'owkowk 去基地帮我整理箱子并拿些木头',
      { topic: 'generic', kind: 'action', nearby: true },
      { inlineUserContent: true }
    )
    const call = harness.calls[0]
    assert.equal(Array.isArray(call.body.tools), true)
    const toolNames = call.body.tools.map(tool => tool?.function?.name).filter(Boolean)
    assert.ok(toolNames.includes('observe_detail'))
    assert.ok(toolNames.includes('goto'))
    assert.ok(toolNames.includes('collect'))
    assert.ok(toolNames.includes('deposit'))
    assert.ok(toolNames.includes('withdraw'))
    assert.equal(toolNames.includes('autofish'), false)
    assert.equal(toolNames.includes('feed_animals'), false)
    assert.equal(toolNames.includes('mine_ore'), false)
    assert.equal(toolNames.includes('harvest'), false)
    const toolTokens = H.estTokensFromText(JSON.stringify(call.body.tools))
    assert.ok(toolTokens < 2100, `expected generic action tool schema < 2100 tokens, got ${toolTokens}`)
  } finally {
    harness.restore()
  }
})

test('generic action does not spend prompt tokens on people profile context', async () => {
  const recent = makeRecentFromLogShape({ day: '2026-01-31', count: 40, chars: 180 })
  const hugeProfile = repeatedText('动作请求不需要的人物画像', 6000)
  const harness = makeExecutor({
    recent,
    people: {
      buildAllProfilesContext: ({ player } = {}) => {
        assert.equal(player, 'kuleizi')
        return `<people>\n<profile n="kuleizi">${hugeProfile}</profile>\n</people>`
      },
      buildAllCommitmentsContext: ({ player } = {}) => {
        assert.equal(player, 'kuleizi')
        return ''
      }
    }
  })
  try {
    await harness.executor.callAI(
      'kuleizi',
      'owkowk 去基地帮我整理箱子并拿些木头',
      { topic: 'generic', kind: 'action', nearby: true },
      { inlineUserContent: true }
    )
    const text = promptTextFromCall(harness.calls[0])
    assert.doesNotMatch(text, /人物画像/)
    assert.doesNotMatch(text, /<people>/)
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
    const toolTokens = H.estTokensFromText(JSON.stringify(harness.calls[0].body.tools))
    assert.ok(toolTokens < 5000, `expected compact plan tool schema < 5000 tokens, got ${toolTokens}`)
    assert.equal((text.match(/<p |<b /g) || []).length <= 20, true)
  } finally {
    harness.restore()
  }
})
