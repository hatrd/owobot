import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'
import peopleMod from '../bot_impl/ai-chat/people.js'

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
