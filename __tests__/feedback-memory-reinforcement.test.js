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

