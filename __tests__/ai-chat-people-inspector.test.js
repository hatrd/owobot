import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'
import peopleMod from '../bot_impl/ai-chat/people.js'
import { createAiCallMonitor } from '../bot_impl/ai-chat/call-monitor.js'

const { createMemoryService } = memoryMod
const { createPeopleService } = peopleMod

test('dialogue summary triggers rule-based people profile overwrite', async () => {
  const state = {
    ai: { key: null },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  let savedPeople = null
  const peopleStore = {
    load: () => ({ profiles: {}, commitments: [] }),
    save: (data) => { savedPeople = JSON.parse(JSON.stringify(data)) }
  }

  const now = () => 1000
  const people = createPeopleService({ state, peopleStore, now })
  const memory = createMemoryService({
    state,
    memoryStore,
    defaults: { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' },
    bot: { username: 'bot' },
    people,
    now
  })

  state.aiRecentSeq = 2
  state.aiRecent.push({ t: now(), user: 'Alice', text: '以后叫我 阿猫', kind: 'player', seq: 1 })
  state.aiRecent.push({ t: now(), user: 'bot', text: '好的', kind: 'bot', seq: 2 })

  const sessionEntry = {
    startSeq: 0,
    lastSeq: 2,
    startedAt: now() - 100,
    lastAt: now(),
    participants: new Set(['Alice'])
  }

  await memory.dialogue.queueSummary('Alice', sessionEntry, 'test')

  assert.ok(state.aiPeople?.profiles?.Alice?.profile)
  assert.match(state.aiPeople.profiles.Alice.profile, /阿猫/)
  assert.ok(savedPeople?.profiles?.Alice?.profile)
})

test('conversation summary permission does not also allow people inspector LLM calls', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'conversation_summary'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = { load: () => ({ profiles: {}, commitments: [] }), save: () => {} }
  const now = () => 2000
  const people = createPeopleService({ state, peopleStore, now })
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"Alice和Bob普通聊天"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    state.aiRecent = [
      { t: now(), user: 'Alice', text: '今天挖矿还挺顺利，矿洞入口在村庄东边，路上有很多火把。', kind: 'player', seq: 1 },
      { t: now(), user: 'Bob', text: '我也去看看，顺便带点食物和木头，免得下面补给不够。', kind: 'player', seq: 2 },
      { t: now(), user: 'bot', text: '注意安全，最好先看一下附近有没有怪物，再决定要不要继续深入。', kind: 'bot', seq: 3 },
      { t: now(), user: 'Alice', text: '如果能找到铁和煤就先标记路线，回头我们一起搬箱子过去。', kind: 'player', seq: 4 },
      { t: now(), user: 'Bob', text: '好，我负责带盾牌，Alice 负责记坐标，bot 你之后提醒我们别迷路。', kind: 'player', seq: 5 }
    ]
    state.aiRecentSeq = 5

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 5,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice', 'Bob'])
    }, 'test')

    assert.equal(fetchCalls, 1)
    assert.equal(state.aiCallMonitor.bySource.conversation_summary.ok, 1)
    assert.equal(state.aiCallMonitor.bySource.people_inspector.blocked, 1)
  } finally {
    global.fetch = oldFetch
  }
})

test('conversation summary records provider usage in AI spend accounting', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'conversation_summary'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = { load: () => ({ profiles: {}, commitments: [] }), save: () => {} }
  const now = () => 2100
  const people = createPeopleService({ state, peopleStore, now })
  const oldFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '{"summary":"Alice和Bob讨论矿洞补给"}' } }],
      usage: { prompt_tokens: 234, completion_tokens: 56 }
    })
  })
  const aiCallMonitor = createAiCallMonitor({ state, now })
  let usage = null
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor,
      applyUsage: (inTok, outTok) => { usage = { inTok, outTok } }
    })

    state.aiRecent = Array.from({ length: 8 }, (_, i) => ({
      t: now() + i,
      user: i % 2 === 0 ? 'Alice' : 'Bob',
      text: `${i}: 我们讨论矿洞补给和路线安排`,
      kind: 'player',
      seq: i + 1
    }))
    state.aiRecentSeq = 8

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 8,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice', 'Bob'])
    }, 'test')

    assert.deepEqual(usage, { inTok: 234, outTok: 56 })
    assert.equal(state.aiCallMonitor.bySource.conversation_summary.ok, 1)
  } finally {
    global.fetch = oldFetch
  }
})

test('background toggle allows conversation summary without chaining people inspector LLM calls', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = { load: () => ({ profiles: {}, commitments: [] }), save: () => {} }
  const now = () => 2500
  const people = createPeopleService({ state, peopleStore, now })
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"Alice和Bob普通聊天"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    state.aiRecent = [
      { t: now(), user: 'Alice', text: '今天挖矿还挺顺利，矿洞入口在村庄东边，路上有很多火把。', kind: 'player', seq: 1 },
      { t: now(), user: 'Bob', text: '我也去看看，顺便带点食物和木头，免得下面补给不够。', kind: 'player', seq: 2 },
      { t: now(), user: 'bot', text: '注意安全，最好先看一下附近有没有怪物，再决定要不要继续深入。', kind: 'bot', seq: 3 },
      { t: now(), user: 'Alice', text: '如果能找到铁和煤就先标记路线，回头我们一起搬箱子过去。', kind: 'player', seq: 4 },
      { t: now(), user: 'Bob', text: '好，我负责带盾牌，Alice 负责记坐标，bot 你之后提醒我们别迷路。', kind: 'player', seq: 5 }
    ]
    state.aiRecentSeq = 5

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 5,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice', 'Bob'])
    }, 'test')

    assert.equal(fetchCalls, 1)
    assert.equal(state.aiCallMonitor.bySource.conversation_summary.ok, 1)
    assert.equal(state.aiCallMonitor.bySource.people_inspector.blocked, 1)
  } finally {
    global.fetch = oldFetch
  }
})

test('short low-signal dialogue summary uses local fallback without external LLM call', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = { load: () => ({ profiles: {}, commitments: [] }), save: () => {} }
  const now = () => 2750
  const people = createPeopleService({ state, peopleStore, now })
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"Alice打招呼"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    state.aiRecentSeq = 2
    state.aiRecent.push({ t: now(), user: 'Alice', text: 'owkowk 你好', kind: 'player', seq: 1 })
    state.aiRecent.push({ t: now(), user: 'bot', text: '你好呀', kind: 'bot', seq: 2 })

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 2,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice'])
    }, 'test')

    assert.equal(fetchCalls, 0)
    assert.equal(state.aiCallMonitor.bySource.conversation_summary?.ok || 0, 0)
    assert.equal(state.aiDialogues.length, 1)
    assert.match(state.aiDialogues[0].summary, /Alice/)
  } finally {
    global.fetch = oldFetch
  }
})

test('conversation summary does not repeat external calls for an already saved seq window', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = { load: () => ({ profiles: {}, commitments: [] }), save: () => {} }
  const now = () => 2850
  const people = createPeopleService({ state, peopleStore, now })
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"Alice和Bob整理矿洞路线"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    state.aiRecent = [
      { t: now(), user: 'Alice', text: '今天先把矿洞入口清出来，路上火把补齐，别再迷路。', kind: 'player', seq: 1 },
      { t: now(), user: 'Bob', text: '我带箱子和木头，顺便把铁和煤都标记一下。', kind: 'player', seq: 2 },
      { t: now(), user: 'bot', text: '路线和补给都记录一下，回来时按火把走。', kind: 'bot', seq: 3 },
      { t: now(), user: 'Alice', text: '回头我们把箱子搬到入口旁边，先不要深入太远。', kind: 'player', seq: 4 },
      { t: now(), user: 'Bob', text: '好的，先整理路线，再搬物资。', kind: 'player', seq: 5 }
    ]
    state.aiRecentSeq = 5
    const entry = {
      startSeq: 1,
      lastSeq: 5,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice', 'Bob'])
    }

    const first = await memory.dialogue.queueSummary('Alice', entry, 'expire')
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = await memory.dialogue.queueSummary('Alice', entry, 'reset')

    assert.equal(first, true)
    assert.equal(second, false)
    assert.equal(fetchCalls, 1)
    assert.equal(state.aiCallMonitor.bySource.conversation_summary.ok, 1)
    assert.equal(state.aiDialogues.filter(d => d?.tier === 'raw').length, 1)
  } finally {
    global.fetch = oldFetch
  }
})

test('conversation summary caps external calls per queue run and falls back locally', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: true, allowSources: ['main_chat'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const now = () => 2900
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"Alice和Bob整理积压聊天摘要"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      now,
      aiCallMonitor
    })

    const long = '这段聊天在讨论矿洞路线、补给箱、火把标记和回程坐标，需要摘要但不值得一次性打爆外部模型。'.repeat(8)
    state.aiRecent = Array.from({ length: 30 }, (_, i) => ({
      t: now() + i,
      user: i % 2 === 0 ? 'Alice' : 'Bob',
      text: `${i}: ${long}`,
      kind: 'player',
      seq: i + 1
    }))
    state.aiRecentSeq = 30

    const promises = Array.from({ length: 6 }, (_, i) => memory.dialogue.queueSummary('Alice', {
      startSeq: i * 5 + 1,
      lastSeq: i * 5 + 5,
      startedAt: now() - 100 + i,
      lastAt: now() + i,
      participants: new Set(['Alice', 'Bob'])
    }, 'burst'))

    const results = await Promise.all(promises)

    assert.deepEqual(results, [true, true, true, true, true, true])
    assert.equal(fetchCalls, 2)
    assert.equal(state.aiCallMonitor.bySource.conversation_summary.ok, 2)
    assert.equal(state.aiDialogues.filter(d => d?.tier === 'raw').length, 6)
  } finally {
    global.fetch = oldFetch
  }
})

test('explicit people inspector skips short low-signal dialogue after local summary', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'people_inspector'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = { load: () => ({ profiles: {}, commitments: [] }), save: () => {} }
  const now = () => 2760
  const people = createPeopleService({ state, peopleStore, now })
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"profiles":[],"commitments":[]}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    state.aiRecentSeq = 2
    state.aiRecent.push({ t: now(), user: 'Alice', text: 'owkowk 你好', kind: 'player', seq: 1 })
    state.aiRecent.push({ t: now(), user: 'bot', text: '你好呀', kind: 'bot', seq: 2 })

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 2,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice'])
    }, 'test')

    assert.equal(fetchCalls, 0)
    assert.equal(state.aiCallMonitor.bySource.people_inspector?.ok || 0, 0)
    assert.equal(state.aiCallMonitor.bySource.conversation_summary?.ok || 0, 0)
    assert.equal(state.aiDialogues.length, 1)
  } finally {
    global.fetch = oldFetch
  }
})

test('explicit people inspector skips short rule-resolved dialogue after local patch', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'people_inspector'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  let savedPeople = null
  const peopleStore = {
    load: () => ({ profiles: {}, commitments: [] }),
    save: (data) => { savedPeople = JSON.parse(JSON.stringify(data)) }
  }
  const now = () => 2770
  const people = createPeopleService({ state, peopleStore, now })
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"profiles":[{"player":"Alice","profile":"重复画像"}],"commitments":[]}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    state.aiRecentSeq = 2
    state.aiRecent.push({ t: now(), user: 'Alice', text: '以后叫我 阿猫', kind: 'player', seq: 1 })
    state.aiRecent.push({ t: now(), user: 'bot', text: '好，我记住啦', kind: 'bot', seq: 2 })

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 2,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice'])
    }, 'test')

    assert.equal(fetchCalls, 0)
    assert.equal(state.aiCallMonitor.bySource.people_inspector?.ok || 0, 0)
    assert.match(state.aiPeople?.profiles?.Alice?.profile || '', /阿猫/)
    assert.match(savedPeople?.profiles?.Alice?.profile || '', /阿猫/)
  } finally {
    global.fetch = oldFetch
  }
})

test('conversation summary permission does not also allow dialogue aggregation LLM calls', async () => {
  const nowTs = Date.UTC(2026, 0, 1, 2, 30, 0)
  const hourStart = (() => {
    const d = new Date(nowTs)
    d.setMinutes(0, 0, 0)
    return d.getTime()
  })()
  const sourceStart = hourStart - 60 * 60 * 1000
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'conversation_summary'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [
      {
        id: 'raw_1',
        tier: 'raw',
        participants: ['Alice'],
        summary: 'Alice在矿洞里找铁',
        startedAt: sourceStart + 5 * 60 * 1000,
        endedAt: sourceStart + 10 * 60 * 1000
      },
      {
        id: 'raw_2',
        tier: 'raw',
        participants: ['Bob'],
        summary: 'Bob准备去帮忙',
        startedAt: sourceStart + 15 * 60 * 1000,
        endedAt: sourceStart + 20 * 60 * 1000
      }
    ],
    aiDialogueBuckets: { hourlyEnd: sourceStart },
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"Alice和Bob整理矿洞"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now: () => nowTs })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      now: () => nowTs,
      aiCallMonitor
    })

    await memory.dialogue.maybeRunAggregation()

    assert.equal(fetchCalls, 0)
    assert.equal(state.aiCallMonitor.bySource.dialogue_aggregation.blocked, 1)
    assert.equal(state.aiCallMonitor.bySource.conversation_summary?.ok || 0, 0)
  } finally {
    global.fetch = oldFetch
  }
})

test('explicit dialogue aggregation uses compact summary payload and small output budget', async () => {
  const nowTs = Date.UTC(2026, 0, 1, 2, 30, 0)
  const hourStart = (() => {
    const d = new Date(nowTs)
    d.setMinutes(0, 0, 0)
    return d.getTime()
  })()
  const sourceStart = hourStart - 60 * 60 * 1000
  const longSummary = '矿洞路线、补给箱、火把标记、怪物处理和回程坐标讨论。'.repeat(6)
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'dialogue_aggregation'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: Array.from({ length: 36 }, (_, i) => ({
      id: `raw_${i}`,
      tier: 'raw',
      participants: [i % 2 === 0 ? 'Alice' : 'Bob'],
      summary: `${i}: ${longSummary}`,
      startedAt: sourceStart + i * 60 * 1000,
      endedAt: sourceStart + i * 60 * 1000 + 30 * 1000
    })),
    aiDialogueBuckets: { hourlyEnd: sourceStart },
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const bodies = []
  const oldFetch = global.fetch
  global.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    bodies.push(body)
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"Alice和Bob整理矿洞路线与补给"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now: () => nowTs })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      now: () => nowTs,
      aiCallMonitor
    })

    await memory.dialogue.maybeRunAggregation()

    assert.equal(state.aiCallMonitor.bySource.dialogue_aggregation.ok, 1)
    assert.equal(bodies.length, 1)
    const body = bodies[0]
    assert.ok(Number(body.max_tokens) <= 96, `expected dialogue_aggregation max_tokens <= 96, got ${body.max_tokens}`)
    const messages = Array.isArray(body.messages) ? body.messages : body.input
    const userPrompt = String(messages?.find(m => m.role === 'user')?.content || '')
    assert.ok(userPrompt.length <= 2600, `expected compact dialogue_aggregation prompt <= 2600 chars, got ${userPrompt.length}`)
  } finally {
    global.fetch = oldFetch
  }
})

test('explicit dialogue aggregation caps external calls per aggregation run', async () => {
  const nowTs = Date.UTC(2026, 0, 1, 12, 30, 0)
  const hourStart = (() => {
    const d = new Date(nowTs)
    d.setMinutes(0, 0, 0)
    return d.getTime()
  })()
  const firstSourceStart = hourStart - 8 * 60 * 60 * 1000
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'dialogue_aggregation'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: Array.from({ length: 8 }, (_, i) => ({
      id: `raw_${i}`,
      tier: 'raw',
      participants: [i % 2 === 0 ? 'Alice' : 'Bob'],
      summary: `${i}: 分散在不同小时的矿洞讨论`,
      startedAt: firstSourceStart + i * 60 * 60 * 1000 + 5 * 60 * 1000,
      endedAt: firstSourceStart + i * 60 * 60 * 1000 + 10 * 60 * 1000
    })),
    aiDialogueBuckets: { hourlyEnd: firstSourceStart },
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  let fetchCalls = 0
  const oldFetch = global.fetch
  global.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"summary":"玩家们分时段讨论矿洞安排"}' } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now: () => nowTs })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      now: () => nowTs,
      aiCallMonitor
    })

    await memory.dialogue.maybeRunAggregation()

    assert.equal(fetchCalls, 2)
    assert.equal(state.aiCallMonitor.bySource.dialogue_aggregation.ok, 2)
    assert.equal(state.aiDialogues.filter(entry => entry.tier === 'raw').length, 6)
  } finally {
    global.fetch = oldFetch
  }
})

test('explicit people inspector uses compact chat excerpt and small output budget', async () => {
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'conversation_summary', 'people_inspector'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = { load: () => ({ profiles: {}, commitments: [] }), save: () => {} }
  const now = () => 3000
  const people = createPeopleService({ state, peopleStore, now })
  const bodies = []
  const oldFetch = global.fetch
  global.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    bodies.push(body)
    const messages = Array.isArray(body.messages) ? body.messages : body.input
    const system = String(messages?.[0]?.content || '')
    const content = system.includes('人物画像/承诺')
      ? '{"profiles":[],"commitments":[]}'
      : '{"summary":"Alice和Bob长时间讨论矿洞与补给"}'
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    const long = '这是一段很长的普通聊天内容，用来模拟服务器玩家连续闲聊和讨论补给路线。'.repeat(30)
    state.aiRecent = Array.from({ length: 100 }, (_, i) => ({
      t: now() + i,
      user: i % 2 === 0 ? 'Alice' : 'Bob',
      text: `${i}: ${long}`,
      kind: 'player',
      seq: i + 1
    }))
    state.aiRecentSeq = 100

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 100,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice', 'Bob'])
    }, 'test')

    const inspectorBody = bodies.find(body => {
      const messages = Array.isArray(body.messages) ? body.messages : body.input
      return String(messages?.[0]?.content || '').includes('人物画像/承诺')
    })
    const summaryBody = bodies.find(body => {
      const messages = Array.isArray(body.messages) ? body.messages : body.input
      return String(messages?.[0]?.content || '').includes('聊天总结助手')
    })
    assert.ok(summaryBody, 'expected conversation_summary request')
    {
      const messages = Array.isArray(summaryBody.messages) ? summaryBody.messages : summaryBody.input
      const userPrompt = String(messages?.find(m => m.role === 'user')?.content || '')
      assert.ok(userPrompt.length <= 3800, `expected compact conversation_summary prompt <= 3800 chars, got ${userPrompt.length}`)
    }
    assert.ok(inspectorBody, 'expected people_inspector request')
    assert.ok(Number(inspectorBody.max_tokens) <= 256, `expected people_inspector max_tokens <= 256, got ${inspectorBody.max_tokens}`)
    const messages = Array.isArray(inspectorBody.messages) ? inspectorBody.messages : inspectorBody.input
    const userPrompt = String(messages?.find(m => m.role === 'user')?.content || '')
    assert.ok(userPrompt.length <= 4200, `expected compact people_inspector prompt <= 4200 chars, got ${userPrompt.length}`)
    assert.equal(state.aiCallMonitor.bySource.people_inspector.ok, 1)
  } finally {
    global.fetch = oldFetch
  }
})

test('people inspector sends one compact known-state snapshot without duplicate prose blocks', async () => {
  const bigProfile = '喜欢红石机器、矿洞补给、末地交通和猫屋装饰，讨厌被叫错名字。'.repeat(40)
  const bigAction = '在主基地北门旁边整理大型物资墙并把矿洞补给路线标记成清晰路牌。'.repeat(25)
  const state = {
    ai: {
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      externalCalls: { allowBackground: false, allowSources: ['main_chat', 'conversation_summary', 'people_inspector'] }
    },
    aiLong: [],
    aiMemory: { entries: [] },
    aiDialogues: [],
    aiRecent: [],
    aiRecentSeq: 0
  }

  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const peopleStore = {
    load: () => ({
      profiles: {
        Alice: { name: 'Alice', profile: bigProfile },
        Bob: { name: 'Bob', profile: bigProfile }
      },
      commitments: [
        { id: 'c1', player: 'Alice', action: bigAction, status: 'pending' },
        { id: 'c2', player: 'Bob', action: bigAction, status: 'ongoing' }
      ]
    }),
    save: () => {}
  }
  const now = () => 3100
  const people = createPeopleService({ state, peopleStore, now })
  const bodies = []
  const oldFetch = global.fetch
  global.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    bodies.push(body)
    const messages = Array.isArray(body.messages) ? body.messages : body.input
    const system = String(messages?.[0]?.content || '')
    const content = system.includes('人物画像/承诺')
      ? '{"profiles":[],"commitments":[]}'
      : '{"summary":"Alice和Bob讨论矿洞补给与承诺状态"}'
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content } }]
      })
    }
  }
  const aiCallMonitor = createAiCallMonitor({ state, now })
  try {
    const memory = createMemoryService({
      state,
      memoryStore,
      defaults: { DEFAULT_BASE: 'https://example.invalid', DEFAULT_PATH: '/v1/chat/completions', DEFAULT_MODEL: 'deepseek-chat' },
      bot: { username: 'bot' },
      people,
      now,
      aiCallMonitor
    })

    state.aiRecent = [
      { t: now(), user: 'Alice', text: '今天先把矿洞补给路线重新标出来，之前承诺那个北门物资墙也快好了。', kind: 'player', seq: 1 },
      { t: now(), user: 'Bob', text: '我还会继续维护末地交通，别把这个长期承诺关掉。', kind: 'player', seq: 2 },
      { t: now(), user: 'bot', text: '我记得你们的安排，会按现有承诺更新。', kind: 'bot', seq: 3 },
      { t: now(), user: 'Alice', text: '如果 c1 算完成了就标完成，还没完成就保持待办。', kind: 'player', seq: 4 },
      { t: now(), user: 'Bob', text: '这段对话应该只用一份紧凑状态，不要重复塞上下文。', kind: 'player', seq: 5 }
    ]
    state.aiRecentSeq = 5

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 5,
      startedAt: now() - 100,
      lastAt: now(),
      participants: new Set(['Alice', 'Bob'])
    }, 'test')

    const inspectorBody = bodies.find(body => {
      const messages = Array.isArray(body.messages) ? body.messages : body.input
      return String(messages?.[0]?.content || '').includes('人物画像/承诺')
    })
    assert.ok(inspectorBody, 'expected people_inspector request')
    const messages = Array.isArray(inspectorBody.messages) ? inspectorBody.messages : inspectorBody.input
    const userPrompt = String(messages?.find(m => m.role === 'user')?.content || '')
    assert.doesNotMatch(userPrompt, /当前已知人物画像/)
    assert.doesNotMatch(userPrompt, /当前已知 bot 承诺/)
    assert.equal((userPrompt.match(/已知人物画像\/承诺/g) || []).length, 1)
    assert.ok(userPrompt.length <= 2400, `expected compact people_inspector known-state prompt <= 2400 chars, got ${userPrompt.length}`)
    assert.ok(!userPrompt.includes(bigProfile.slice(0, 260)), 'expected long profiles to be clipped before LLM call')
    assert.ok(!userPrompt.includes(bigAction.slice(0, 220)), 'expected long commitments to be clipped before LLM call')
  } finally {
    global.fetch = oldFetch
  }
})
