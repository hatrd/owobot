import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'
import H from '../bot_impl/ai-chat-helpers.js'

const { createMemoryService } = memoryMod

test('buildMemoryContext(debug) returns scored memory debug info', async () => {
  const state = {
    ai: { context: { memory: { include: true, max: 2 } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  state.aiMemory.entries = [
    { id: 'm1', text: '基地坐标是 100,64,200', instruction: '基地坐标是 100,64,200', summary: '基地坐标', triggers: ['坐标'], tags: [], count: 2, createdAt: 10, updatedAt: 10, lastAuthor: 'A' },
    { id: 'm2', text: '这是基地介绍', instruction: '这是基地介绍', summary: '基地', triggers: [], tags: ['基地'], count: 9, createdAt: 20, updatedAt: 20, lastAuthor: 'B' }
  ]

  const res = await memory.longTerm.buildContext({ query: '基地坐标', withRefs: true, debug: true, debugLimit: 5, limit: 2 })
  assert.equal(typeof res, 'object')
  assert.match(res.text, /长期记忆:/)
  assert.deepEqual(res.refs.slice(0, 2), ['m1', 'm2'])
  assert.equal(res.debug?.mode, 'keyword')
  assert.ok(Array.isArray(res.debug?.tokens) && res.debug.tokens.includes('坐标'))
  assert.ok(Array.isArray(res.debug?.scoredTop) && res.debug.scoredTop.length > 0)
  assert.equal(res.debug.scoredTop[0]?.entry?.id, 'm1')
  assert.ok(res.debug.scoredTop[0]?.tokenMatches?.some(t => t && t.match === 'trigger'))

  assert.equal(res.trace?.version, 1)
  assert.equal(res.trace?.mode, 'keyword')
  assert.equal(res.trace?.tokenEstimate, H.estTokensFromText(res.text))
  assert.deepEqual(res.trace?.refs?.slice(0, 2), ['m1', 'm2'])
})
