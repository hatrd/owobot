import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'

const { createMemoryService } = memoryMod

test('memory v2: no recent fallback when query has no usable tokens', async () => {
  const state = {
    ai: { context: { memory: { include: true, max: 3, mode: 'v2' } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  state.aiMemory.entries = [
    { id: 'm1', text: 'Alice 的家在 1,64,2', instruction: 'Alice 的家在 1,64,2', summary: 'Alice 家坐标', count: 1, createdAt: 10, updatedAt: 10, lastAuthor: 'Alice' }
  ]

  const ctx = await memory.longTerm.buildContext({ query: '你好', actor: 'Alice', withRefs: false })
  assert.equal(ctx, '')
})

test('memory v2: recency breaks ties when relevance is similar', async () => {
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
          relevanceScale: 18,
          importanceCountSaturation: 20
        }
      }
    },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' }, now })

  state.aiMemory.entries = [
    { id: 'old', text: '基地坐标是 1,64,2', instruction: '基地坐标是 1,64,2', summary: '基地坐标 old', triggers: ['坐标'], count: 1, createdAt: t - 30 * day, updatedAt: t - 30 * day, lastAuthor: 'Alice' },
    { id: 'new', text: '基地坐标是 3,70,4', instruction: '基地坐标是 3,70,4', summary: '基地坐标 new', triggers: ['坐标'], count: 1, createdAt: t - 1 * day, updatedAt: t - 1 * day, lastAuthor: 'Alice' }
  ]

  const res = await memory.longTerm.buildContext({ query: '基地坐标', actor: 'Alice', withRefs: true })
  assert.match(res.text, /长期记忆:/)
  assert.match(res.text, /基地坐标 new/)
  assert.deepEqual(res.refs.slice(0, 2), ['new', 'old'])
})

test('memory v2: dedupes same location to keep context diverse', async () => {
  const state = {
    ai: {
      context: {
        memory: {
          include: true,
          max: 2,
          mode: 'v2',
          minScore: 0,
          minRelevance: 0,
          wRelevance: 1,
          wRecency: 0,
          wImportance: 0,
          relevanceScale: 10
        }
      }
    },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  state.aiMemory.entries = [
    {
      id: 'm1',
      text: '基地坐标是 1,64,2',
      instruction: '基地坐标是 1,64,2',
      summary: '基地坐标 A',
      triggers: ['坐标'],
      count: 1,
      createdAt: 10,
      updatedAt: 10,
      lastAuthor: 'Alice',
      location: { x: 1, y: 64, z: 2, dim: 'minecraft:overworld' }
    },
    {
      id: 'm2',
      text: '基地坐标还是 1,64,2',
      instruction: '基地坐标还是 1,64,2',
      summary: '基地坐标 B',
      triggers: ['坐标'],
      count: 1,
      createdAt: 11,
      updatedAt: 11,
      lastAuthor: 'Alice',
      location: { x: 1, y: 64, z: 2, dim: 'minecraft:overworld' }
    },
    {
      id: 'm3',
      text: '村庄坐标是 9,70,9',
      instruction: '村庄坐标是 9,70,9',
      summary: '村庄坐标',
      triggers: ['坐标'],
      count: 1,
      createdAt: 12,
      updatedAt: 12,
      lastAuthor: 'Alice',
      location: { x: 9, y: 70, z: 9, dim: 'minecraft:overworld' }
    }
  ]

  const res = await memory.longTerm.buildContext({ query: '坐标', actor: 'Alice', withRefs: true })
  assert.equal(res.refs.length, 2)
  assert.ok(res.refs.includes('m3'))
  assert.ok(res.refs.includes('m1') || res.refs.includes('m2'))
})

