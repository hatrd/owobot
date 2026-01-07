import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'

const { createMemoryService } = memoryMod

test('buildMemoryContext falls back to most recent memories (not highest count)', async () => {
  const state = {
    ai: { context: { memory: { include: true, max: 2 } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  state.aiMemory.entries = [
    { text: 'old', instruction: 'old', summary: 'old', count: 999, createdAt: 1, updatedAt: 1, lastAuthor: 'A' },
    { text: 'new1', instruction: 'new1', summary: 'new1', count: 1, createdAt: 100, updatedAt: 100, lastAuthor: 'B' },
    { text: 'new2', instruction: 'new2', summary: 'new2', count: 1, createdAt: 101, updatedAt: 101, lastAuthor: 'C' }
  ]

  const ctx = await memory.longTerm.buildContext({ query: '', withRefs: false })
  assert.match(ctx, /长期记忆:/)
  assert.match(ctx, /1\. new2/)
  assert.match(ctx, /2\. new1/)
  assert.doesNotMatch(ctx, /old/)
})
