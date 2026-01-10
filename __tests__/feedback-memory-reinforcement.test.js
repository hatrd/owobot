import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'
import feedbackMod from '../bot_impl/ai-chat/feedback-collector.js'

const { createMemoryService } = memoryMod
const { createFeedbackCollector } = feedbackMod

test('engagement-only feedback does not refresh memory count/updatedAt', async () => {
  let t = 1000
  const now = () => t
  const state = {
    ai: { context: { memory: { include: true, max: 6 } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }), saveEvolution: () => {} }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' }, now })

  state.aiMemory.entries = [
    { id: 'm1', text: 'foo', instruction: 'foo', summary: 'foo', count: 5, createdAt: 1, updatedAt: 1, firstAuthor: 'kuleizi', lastAuthor: 'kuleizi' }
  ]

  const feedback = createFeedbackCollector({ state, bot: { username: 'bot' }, log: null, now, memoryStore, memory })
  const windowId = feedback.openFeedbackWindow({ botMessage: 'hi', targetUser: 'kuleizi', memoryRefs: ['m1'] })

  // Player continues chatting without explicit positive/negative signals.
  t += 1000
  feedback.processPlayerMessage('kuleizi', '嗯')

  t += 1000
  feedback.resolveWindow(windowId)

  const entry = state.aiMemory.entries.find(e => e.id === 'm1')
  assert.equal(entry.count, 5)
  assert.equal(entry.updatedAt, 1)
})

test('explicit negative feedback decays memory without refreshing updatedAt', async () => {
  let t = 1000
  const now = () => t
  const state = {
    ai: { context: { memory: { include: true, max: 6 } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }), saveEvolution: () => {} }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' }, now })

  state.aiMemory.entries = [
    { id: 'm1', text: 'foo', instruction: 'foo', summary: 'foo', count: 5, createdAt: 1, updatedAt: 1, firstAuthor: 'kuleizi', lastAuthor: 'kuleizi' }
  ]

  const feedback = createFeedbackCollector({ state, bot: { username: 'bot' }, log: null, now, memoryStore, memory })
  const windowId = feedback.openFeedbackWindow({ botMessage: 'hi', targetUser: 'kuleizi', memoryRefs: ['m1'] })

  // Explicit negative signal (FRUSTRATION matches /别/).
  t += 1000
  feedback.processPlayerMessage('kuleizi', '别这样')

  t += 1000
  feedback.resolveWindow(windowId)

  const entry = state.aiMemory.entries.find(e => e.id === 'm1')
  assert.equal(entry.count, 3)
  assert.equal(entry.updatedAt, 1)
})

test('explicit positive feedback updates lastPositiveFeedback and affects v2 recency without touching updatedAt', async () => {
  const day = 24 * 60 * 60 * 1000
  let t = 1000 * day
  const now = () => t
  const state = {
    ai: {
      context: {
        memory: {
          include: true,
          max: 2,
          mode: 'v2',
          minScore: 0,
          minRelevance: 0,
          wRelevance: 0.5,
          wRecency: 0.5,
          wImportance: 0,
          recencyHalfLifeDays: 7,
          relevanceScale: 18
        }
      }
    },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }), saveEvolution: () => {} }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' }, now })

  const oldTs = t - 30 * day
  state.aiMemory.entries = [
    { id: 'm1', text: '基地坐标是 1,64,2', instruction: '基地坐标是 1,64,2', summary: '基地坐标 A', triggers: ['坐标'], count: 1, createdAt: oldTs, updatedAt: oldTs, lastAuthor: 'Alice', scope: 'player', owners: ['Alice'] },
    { id: 'm2', text: '基地坐标是 3,70,4', instruction: '基地坐标是 3,70,4', summary: '基地坐标 B', triggers: ['坐标'], count: 1, createdAt: oldTs, updatedAt: oldTs, lastAuthor: 'Alice', scope: 'player', owners: ['Alice'] }
  ]

  const feedback = createFeedbackCollector({ state, bot: { username: 'bot' }, log: null, now, memoryStore, memory })
  const windowId = feedback.openFeedbackWindow({ botMessage: 'hi', targetUser: 'Alice', memoryRefs: ['m1'] })

  t += 1000
  feedback.processPlayerMessage('Alice', '谢谢')

  t += 1000
  feedback.resolveWindow(windowId)
  const expectedLastPositive = t

  const entry = state.aiMemory.entries.find(e => e.id === 'm1')
  assert.equal(entry.updatedAt, oldTs)
  assert.equal(entry.effectiveness?.lastPositiveFeedback, expectedLastPositive)

  const res = await memory.longTerm.buildContext({ query: '基地坐标', actor: 'Alice', withRefs: true })
  assert.equal(res.refs[0], 'm1')
})
