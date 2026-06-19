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

    state.aiRecentSeq = 3
    state.aiRecent.push({ t: now(), user: 'Alice', text: '今天挖矿还挺顺利', kind: 'player', seq: 1 })
    state.aiRecent.push({ t: now(), user: 'Bob', text: '我也去看看', kind: 'player', seq: 2 })
    state.aiRecent.push({ t: now(), user: 'bot', text: '注意安全', kind: 'bot', seq: 3 })

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 3,
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

    state.aiRecentSeq = 3
    state.aiRecent.push({ t: now(), user: 'Alice', text: '今天挖矿还挺顺利', kind: 'player', seq: 1 })
    state.aiRecent.push({ t: now(), user: 'Bob', text: '我也去看看', kind: 'player', seq: 2 })
    state.aiRecent.push({ t: now(), user: 'bot', text: '注意安全', kind: 'bot', seq: 3 })

    await memory.dialogue.queueSummary('Alice', {
      startSeq: 1,
      lastSeq: 3,
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
