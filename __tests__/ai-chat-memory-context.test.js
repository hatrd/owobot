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

test('buildMemoryContext injects nearby location memories by distance', async () => {
  const state = {
    ai: { context: { memory: { include: true, max: 3, mode: 'keyword' } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const bot = { username: 'bot', game: { dimension: 'minecraft:overworld' }, entity: { position: { x: 10, y: 64, z: 0 } } }
  const memory = createMemoryService({ state, memoryStore, defaults, bot })

  state.aiMemory.entries = [
    { text: 'spawn', instruction: 'spawn', summary: 'spawn', count: 1, createdAt: 1, updatedAt: 1, lastAuthor: 'A', location: { x: 0, y: 64, z: 0, radius: 30, dim: 'minecraft:overworld' } },
    { text: 'far', instruction: 'far', summary: 'far', count: 1, createdAt: 2, updatedAt: 2, lastAuthor: 'B', location: { x: 500, y: 64, z: 0, radius: 30, dim: 'minecraft:overworld' } }
  ]

  const ctx = await memory.longTerm.buildContext({ query: '', withRefs: false, actor: 'Alice' })
  assert.match(ctx, /长期记忆:/)
  assert.match(ctx, /spawn/)
  assert.match(ctx, /0,64,0/)
  assert.doesNotMatch(ctx, /far/)
})
