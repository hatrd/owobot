import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'

const { createMemoryService } = memoryMod

test('buildMemoryContext filters player-scoped memories by actor (prevents cross-player contamination)', async () => {
  const state = {
    ai: { context: { memory: { include: true, max: 6 } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  state.aiMemory.entries = [
    { id: 'a1', text: 'Alice 的家在 1,64,2', instruction: 'Alice 的家在 1,64,2', summary: 'Alice 家坐标', count: 1, createdAt: 10, updatedAt: 10, lastAuthor: 'Alice' },
    { id: 'b1', text: 'Bob 的家在 9,70,9', instruction: 'Bob 的家在 9,70,9', summary: 'Bob 家坐标', count: 1, createdAt: 11, updatedAt: 11, lastAuthor: 'Bob' },
    { id: 'g1', text: '全服规则：不要偷东西', instruction: '全服规则：不要偷东西', summary: '全服规则', count: 1, createdAt: 12, updatedAt: 12, lastAuthor: 'bot', scope: 'global' }
  ]

  const ctx = await memory.longTerm.buildContext({ query: '家在', actor: 'Alice', withRefs: false })
  assert.match(ctx, /Alice/)
  assert.doesNotMatch(ctx, /Bob/)
})

test('buildMemoryContext recent fallback also respects actor-scoped namespaces', async () => {
  const state = {
    ai: { context: { memory: { include: true, max: 2 } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  state.aiMemory.entries = [
    { id: 'a1', text: 'Alice 的家在 1,64,2', instruction: 'Alice 的家在 1,64,2', summary: 'Alice 家坐标', count: 1, createdAt: 10, updatedAt: 10, lastAuthor: 'Alice' },
    { id: 'b1', text: 'Bob 的家在 9,70,9', instruction: 'Bob 的家在 9,70,9', summary: 'Bob 家坐标', count: 1, createdAt: 11, updatedAt: 11, lastAuthor: 'Bob' },
    { id: 'g1', text: '全服规则：不要偷东西', instruction: '全服规则：不要偷东西', summary: '全服规则', count: 1, createdAt: 12, updatedAt: 12, lastAuthor: 'bot', scope: 'global' }
  ]

  const ctx = await memory.longTerm.buildContext({ query: '', actor: 'Alice', withRefs: false })
  assert.match(ctx, /Alice/)
  assert.doesNotMatch(ctx, /Bob/)
})

